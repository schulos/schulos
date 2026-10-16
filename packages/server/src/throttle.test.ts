import { describe, expect, it } from "vitest";
import { afterHit, blockingLock, hasRecentFailures, rateWindowExpired, THROTTLE, type RateState, type ThrottleState } from "./throttle";

const t0 = new Date("2026-10-10T08:00:00Z");
const min = (n: number) => new Date(t0.getTime() + n * 60_000);
const locked: ThrottleState = { failures: THROTTLE.maxPerIp, windowStartedAt: t0, lockedUntil: min(15) };

describe("blockingLock (SEC-04)", () => {
  it("Kontosperre gilt immer", () => {
    const user: ThrottleState = { failures: 5, windowStartedAt: t0, lockedUntil: min(15) };
    expect(blockingLock(user, undefined, true, min(1))).toEqual(min(15));
    expect(blockingLock(user, undefined, true, min(16))).toBeNull();
  });

  it("IP-Sperre gilt für unbekannte Namen und Konten mit Fehlversuchen – nicht für ein Konto, das sauber anmeldet", () => {
    expect(blockingLock(undefined, locked, false, min(1))).toEqual(min(15));
    expect(blockingLock(undefined, locked, true, min(1))).toBeNull();
    const oneFailure: ThrottleState = { failures: 1, windowStartedAt: min(2), lockedUntil: null };
    expect(blockingLock(oneFailure, locked, true, min(3))).toEqual(min(15));
    // Fehlversuch aus dem letzten Fenster zählt nicht mehr
    expect(blockingLock({ failures: 1, windowStartedAt: t0, lockedUntil: null }, { ...locked, lockedUntil: min(30) }, true, min(20))).toBeNull();
  });

  it("späteste Sperre gewinnt", () => {
    const user: ThrottleState = { failures: 5, windowStartedAt: t0, lockedUntil: min(20) };
    expect(blockingLock(user, locked, true, min(1))).toEqual(min(20));
  });

  it("hasRecentFailures: im Fenster ja, nach Ablauf oder abgelaufener Sperre nein", () => {
    expect(hasRecentFailures(undefined, t0)).toBe(false);
    expect(hasRecentFailures({ failures: 2, windowStartedAt: t0, lockedUntil: null }, min(10))).toBe(true);
    expect(hasRecentFailures({ failures: 2, windowStartedAt: t0, lockedUntil: null }, min(16))).toBe(false);
    expect(hasRecentFailures({ failures: 5, windowStartedAt: t0, lockedUntil: min(5) }, min(6))).toBe(false);
  });
});

describe("afterHit (P4-31)", () => {
  const t0 = new Date("2026-10-10T08:00:00Z");
  const min = (n: number) => new Date(t0.getTime() + n * 60_000);
  it("bis max erlaubt, danach gesperrt bis Fensterende; neues Fenster danach", () => {
    const rule = { max: 3, windowMinutes: 60 };
    let s: RateState | undefined;
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r = afterHit(s, rule, min(i));
      allowed.push(r.allowed);
      s = r;
    }
    expect(allowed).toEqual([true, true, true, false, false]);
    expect(s!.blockedUntil).toEqual(min(60));
    expect(rateWindowExpired(s, rule, min(59))).toBe(false);
    expect(afterHit(s, rule, min(60))).toMatchObject({ allowed: true, count: 1, windowStartedAt: min(60), blockedUntil: null });
  });
  it("mit lockMinutes: Sperre ab dem letzten Versuch, auch über das Fenster hinaus", () => {
    const rule = { max: 1, windowMinutes: 15, lockMinutes: 30 };
    const a = afterHit(undefined, rule, min(0));
    const b = afterHit(a, rule, min(14));
    expect(b).toMatchObject({ allowed: false, blockedUntil: min(44) });
    expect(afterHit(b, rule, min(20)).allowed).toBe(false);
    expect(afterHit(b, rule, min(44)).allowed).toBe(true);
  });
});
