import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { rateLimits } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { consumeRate, emailSubject, ipSubject, ipv6Prefix48, pruneRateLimits, rateBlocked, rateKey, rateLimitMessage, RATE_RULES, resetRate } from "./rate-limit";

describe("Rate-Limit – rein", () => {
  it("IPv6 auf /64 gekürzt, IPv4 (auch eingebettet) unverändert", () => {
    expect(ipSubject("203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(ipSubject("2001:db8:abcd:12::99")).toBe("2001:db8:abcd:12::/64");
    expect(ipSubject("[2001:DB8::1]")).toBe("2001:db8:0:0::/64");
    expect(ipSubject("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("Schlüssel: kein Klartext, je Zweck verschieden, unabhängig von Groß-/Kleinschreibung", () => {
    const k = rateKey("anmeldung.email", "Eltern@Example.org", "s");
    expect(k).toMatch(/^anmeldung\.email:[0-9a-f]{40}$/);
    expect(k).not.toContain("example");
    expect(rateKey("anmeldung.email", "eltern@example.org", "s")).toBe(k);
    expect(rateKey("anmeldung.ip", "eltern@example.org", "s")).not.toBe(k);
    expect(rateKey("anmeldung.email", "eltern@example.org", "anderes-geheimnis")).not.toBe(k);
  });

  it("GATE-4c: IPv6 zusätzlich als /48, E-Mail ohne Plus-Zusatz und Groß/Klein", () => {
    expect(ipv6Prefix48(ipSubject("2001:db8:abcd:12::99"))).toBe("2001:db8:abcd::/48");
    expect(ipv6Prefix48(ipSubject("2001:db8:abcd:ff::1"))).toBe("2001:db8:abcd::/48");
    expect(ipv6Prefix48(ipSubject("[2001:DB8::1]"))).toBe("2001:db8:0::/48");
    expect(ipv6Prefix48("203.0.113.7")).toBeNull();
    expect(ipv6Prefix48("unbekannt")).toBeNull();
    expect(emailSubject("Eltern+1@Example.org")).toBe("eltern@example.org");
    expect(emailSubject("eltern+x+y@example.org")).toBe("eltern@example.org");
    expect(emailSubject(" eltern@example.org ")).toBe("eltern@example.org");
    expect(emailSubject("+nur@example.org")).toBe("+nur@example.org");
    expect(emailSubject("kaputt")).toBe("kaputt");
  });

  it("Hinweis in Alltagssprache", () => {
    expect(rateLimitMessage(new Date("2026-10-10T12:30:00Z"))).toBe("Zu viele Anfragen in kurzer Zeit. Bitte ab 14:30 Uhr noch einmal versuchen.");
  });
});

describe("Rate-Limit – Datenbank", () => {
  let h: DbHandle;
  const t0 = new Date("2030-01-01T08:00:00Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.db.delete(rateLimits);
  });

  it("11. Einreichung von einer IP in einer Stunde wird abgewiesen, nach Fensterende geht es wieder", async () => {
    const ip = ipSubject("198.51.100.4");
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await consumeRate(h.db, "anmeldung.ip", ip, at(i)));
    expect(results.map((r) => r.allowed)).toEqual([...Array(10).fill(true), false]);
    expect(results[10]).toMatchObject({ count: 11, retryAt: at(60) });
    expect(await rateBlocked(h.db, "anmeldung.ip", ip, at(30))).toEqual(at(60));
    // andere IP und anderer Zweck sind unabhängig
    expect((await consumeRate(h.db, "anmeldung.ip", "198.51.100.5", at(30))).allowed).toBe(true);
    expect((await consumeRate(h.db, "anmeldung.token", ip, at(30))).allowed).toBe(true);
    expect((await consumeRate(h.db, "anmeldung.ip", ip, at(60))).allowed).toBe(true);
    expect(await rateBlocked(h.db, "anmeldung.ip", ip, at(60))).toBeNull();
  });

  it("gleichzeitige Vorgänge zählen alle (atomarer Upsert)", async () => {
    const rule = { max: 5, windowMinutes: 60 };
    const res = await Promise.all(Array.from({ length: 8 }, () => consumeRate(h.db, "anmeldung.email", "parallel@example.org", t0, rule)));
    expect(res.filter((r) => r.allowed)).toHaveLength(5);
    expect(res.map((r) => r.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("Sperre mit lockMinutes verlängert sich bei weiteren Versuchen; Zurücksetzen und Aufräumen", async () => {
    const rule = { max: 2, windowMinutes: 15, lockMinutes: 30 };
    for (let i = 0; i < 3; i++) await consumeRate(h.db, "anmeldung.token", "x", at(i), rule);
    expect(await rateBlocked(h.db, "anmeldung.token", "x", at(3))).toEqual(at(32));
    expect((await consumeRate(h.db, "anmeldung.token", "x", at(20), rule)).retryAt).toEqual(at(50));
    const [row] = await h.db.select().from(rateLimits);
    expect(row!.expiresAt).toEqual(at(50));
    expect(row!.key).not.toContain("x");
    expect(await pruneRateLimits(h.db, at(49))).toBe(0);
    expect(await pruneRateLimits(h.db, at(51))).toBe(1);
    await consumeRate(h.db, "konto.email", "u-1", t0);
    await resetRate(h.db, "konto.email", "u-1");
    expect(await h.db.select().from(rateLimits)).toEqual([]);
  });

  it("Regeln aus PHASE4 §3.3", () => {
    expect(RATE_RULES["anmeldung.ip"]).toEqual({ max: 10, windowMinutes: 60 });
    expect(RATE_RULES["anmeldung.email"]).toEqual({ max: 5, windowMinutes: 1440 });
    expect(RATE_RULES["anmeldung.token"]).toEqual({ max: 20, windowMinutes: 15 });
  });
});
