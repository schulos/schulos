import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, authThrottle } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { createAuth, createUserWithPassword, hashPassword, type Auth } from "./auth";
import { activeLock, lockedLogins, recordFailure, unlockLogin } from "./sperre";
import { afterFailure, clientIp, isLocked, lockMessage, THROTTLE, userKey } from "@schulos/server/throttle";

const t0 = new Date("2026-10-05T08:00:00Z");
const min = (n: number) => new Date(t0.getTime() + n * 60_000);

describe("afterFailure (rein)", () => {
  it("zählt im Fenster hoch und sperrt beim Erreichen der Grenze für 15 Minuten", () => {
    let s = afterFailure(undefined, 3, t0);
    expect(s).toEqual({ failures: 1, windowStartedAt: t0, lockedUntil: null });
    s = afterFailure(s, 3, min(1));
    expect(s.failures).toBe(2);
    s = afterFailure(s, 3, min(2));
    expect(s.lockedUntil).toEqual(min(2 + THROTTLE.lockMinutes));
    expect(isLocked(s, min(10))).toBe(true);
    expect(isLocked(s, min(17))).toBe(false);
  });

  it("neues Fenster nach Ablauf – alte Fehlversuche verfallen; nach einer Sperre beginnt die Zählung neu", () => {
    const s = afterFailure({ failures: 2, windowStartedAt: t0, lockedUntil: null }, 3, min(16));
    expect(s).toEqual({ failures: 1, windowStartedAt: min(16), lockedUntil: null });
    const after = afterFailure({ failures: 3, windowStartedAt: t0, lockedUntil: min(5) }, 3, min(6));
    expect(after.failures).toBe(1);
  });

  it("IP aus Proxy-Headern, Meldung mit Uhrzeit", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "10.0.0.7, 172.16.0.1" }))).toBe("10.0.0.7");
    expect(clientIp(new Headers({ "x-real-ip": "10.0.0.8" }))).toBe("10.0.0.8");
    expect(clientIp(new Headers())).toBeNull();
    expect(lockMessage(new Date("2026-10-05T08:15:00Z"))).toBe("Zu viele Fehlversuche. Die Anmeldung ist bis 10:15 Uhr gesperrt.");
    expect(userKey(" Jana.Brandt ")).toBe("u:jana.brandt");
  });
});

describe("Anmeldesperre (Better-Auth-Hook + PGlite)", () => {
  let h: DbHandle;
  let auth: Auth;
  const PW = "geheim123";
  const signIn = (username: string, password: string, ip?: string) =>
    auth.api.signInUsername({ body: { username, password }, headers: new Headers(ip ? { "x-forwarded-for": ip } : {}) });

  beforeAll(async () => {
    h = await createTestDb();
    auth = createAuth(h.db);
    const hash = await hashPassword(PW);
    await createUserWithPassword(h.db, { id: "lk", name: "Jana Brandt", username: "jana", role: "lehrkraft" }, { hash });
    await createUserWithPassword(h.db, { id: "lk2", name: "Tobias Kleine", username: "tobias", role: "lehrkraft" }, { hash });
  });
  afterAll(() => h.close());

  it("5 falsche Passwörter sperren das Konto – auch das richtige Passwort hilft dann nicht; Audit ohne IP", async () => {
    for (let i = 0; i < THROTTLE.maxPerUser; i++) await expect(signIn("jana", "falsch!!", "10.0.0.1")).rejects.toThrow();
    await expect(signIn("jana", PW, "10.0.0.2")).rejects.toThrow(/Zu viele Fehlversuche/);
    const [row] = await h.db.select().from(auditLog).where(eq(auditLog.action, "konto.anmeldung.gesperrt"));
    expect(row?.target).toBe("lk");
    expect(JSON.stringify(row?.meta)).not.toContain("10.0.0");
    // andere Konten sind nicht betroffen
    expect((await signIn("tobias", PW, "10.0.0.1")).token).toBeTruthy();
  });

  it("Verwaltung sieht die Sperre und hebt sie auf", async () => {
    const locked = await lockedLogins(h.db);
    expect(locked).toEqual([expect.objectContaining({ username: "jana", userId: "lk", name: "Jana Brandt", failures: 5 })]);
    await unlockLogin(h.db, "lk2", "jana");
    expect(await lockedLogins(h.db)).toEqual([]);
    expect((await signIn("jana", PW)).token).toBeTruthy();
    const [row] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.user.anmeldesperre_aufgehoben"));
    expect(row?.target).toBe("lk");
  });

  it("unbekannte Benutzernamen werden genauso gesperrt (kein Ausprobieren, welche Konten es gibt)", async () => {
    for (let i = 0; i < THROTTLE.maxPerUser; i++) await expect(signIn("gibtsnicht", "x")).rejects.toThrow();
    await expect(signIn("gibtsnicht", "x")).rejects.toThrow(/Zu viele Fehlversuche/);
    expect(await lockedLogins(h.db)).toEqual([expect.objectContaining({ username: "gibtsnicht", userId: null })]);
  });

  it("Erfolg setzt den Zähler des Kontos zurück; die IP-Grenze sperrt unbekannte Namen und Konten mit Fehlversuchen (SEC-04)", async () => {
    await expect(signIn("tobias", "falsch!!")).rejects.toThrow();
    await signIn("tobias", PW);
    expect(await h.db.select().from(authThrottle).where(eq(authThrottle.key, "u:tobias"))).toHaveLength(0);

    for (let i = 0; i < THROTTLE.maxPerIp; i++) await recordFailure(h.db, `name${i}`, "10.9.9.9");
    // unbekannte Namen von dieser Adresse: gesperrt
    expect(await activeLock(h.db, "name99", "10.9.9.9")).not.toBeNull();
    expect(await activeLock(h.db, "name99", "10.9.9.8")).toBeNull();
    // bekanntes Konto ohne Fehlversuche: kommt trotz IP-Sperre an (gemeinsame NAT-Adresse im Schulnetz)
    expect(await activeLock(h.db, "tobias", "10.9.9.9")).toBeNull();
    // erster Fehlversuch für das Konto → ab jetzt greift die IP-Sperre auch dort (je Konto ein Versuch pro Fenster)
    await expect(signIn("tobias", "falsch!!", "10.9.9.9")).rejects.toThrow();
    await expect(signIn("tobias", PW, "10.9.9.9")).rejects.toThrow(/Zu viele Fehlversuche/);
    expect((await signIn("tobias", PW, "10.9.9.8")).token).toBeTruthy();
  });

  it("gleichzeitige Fehlversuche zählen alle (atomar in der DB) – genau ein Audit-Eintrag beim Sperrbeginn", async () => {
    await h.db.delete(auditLog).where(eq(auditLog.action, "konto.anmeldung.gesperrt"));
    await Promise.all(Array.from({ length: THROTTLE.maxPerUser + 2 }, () => recordFailure(h.db, "jana", "10.7.7.7", t0)));
    const [row] = await h.db.select().from(authThrottle).where(eq(authThrottle.key, "u:jana"));
    expect(row?.failures).toBe(THROTTLE.maxPerUser + 2);
    expect(row?.lockedUntil).toEqual(min(THROTTLE.lockMinutes));
    const [ip] = await h.db.select().from(authThrottle).where(eq(authThrottle.key, "ip:10.7.7.7"));
    expect(ip?.failures).toBe(THROTTLE.maxPerUser + 2);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "konto.anmeldung.gesperrt"))).toHaveLength(1);
  });

  it("DB-Zähler folgt denselben Regeln wie afterFailure (Fenster, Sperre, Neubeginn nach der Sperre)", async () => {
    const steps = [0, 1, 2, 20, 21, 22, 23, 24, 30, 40, 41];
    let expected: ReturnType<typeof afterFailure> | undefined;
    for (const m of steps) {
      expected = afterFailure(expected, THROTTLE.maxPerUser, min(m));
      await recordFailure(h.db, "regeln", null, min(m));
      const [row] = await h.db.select().from(authThrottle).where(eq(authThrottle.key, "u:regeln"));
      expect({ failures: row?.failures, windowStartedAt: row?.windowStartedAt, lockedUntil: row?.lockedUntil }, `Minute ${m}`).toEqual(expected);
    }
  });
});
