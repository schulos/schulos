import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, notenbuchOfflineDevices, sessions } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { readSecuritySettings } from "@/core/settings";
import { IDLE_MINUTES } from "@/modules/notenbuch/sitzung";
import { activityTracker } from "@schulos/ui/passive";
import { saveSecuritySettings } from "./anmelde-einstellungen";
import { createUserWithPassword } from "./auth";
import {
  deviceLabel,
  endAllOwnSessions,
  endOwnSession,
  IDLE_OPTIONS,
  listOwnSessions,
  offlineDeviceCount,
  requestActivity,
  sessionActivity,
  sessionIdleExpired,
} from "./sitzungen";

describe("P4-71: Inaktivitätsablauf (rein)", () => {
  it("aus = nie; sonst nach der Einstellung", () => {
    const t = new Date("2026-10-14T10:00:00Z");
    expect(sessionIdleExpired(new Date("2026-10-01T10:00:00Z"), t, 0)).toBe(false);
    expect(sessionIdleExpired(new Date("2026-10-14T09:31:00Z"), t, 30)).toBe(false);
    expect(sessionIdleExpired(new Date("2026-10-14T09:29:00Z"), t, 30)).toBe(true);
  });

  it("keine Stufe kürzer als die Notenbuch-Sperre (Q-5A-7) – das Notenbuch bleibt mindestens so streng", () => {
    for (const m of IDLE_OPTIONS) expect(m === 0 || m >= IDLE_MINUTES).toBe(true);
  });

  it("Gerätename aus dem User-Agent", () => {
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1")).toBe("Safari auf iPad");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36 Edg/120.0")).toBe("Edge auf Windows");
    expect(deviceLabel(null)).toBe("Unbekanntes Gerät");
  });
});

describe("P4-71: Sitzungen mit Datenbank", () => {
  let h: DbHandle;
  const t0 = new Date("2026-10-14T08:00:00Z");

  async function session(id: string, userId: string, created = t0) {
    await h.db
      .insert(sessions)
      .values({
        id,
        token: `t-${id}`,
        userId,
        expiresAt: new Date(created.getTime() + 7 * 86_400_000),
        createdAt: created,
        userAgent: "Firefox/120 (X11; Linux)",
      });
  }
  async function offline(deviceId: string, userId: string, sessionId: string | null) {
    await h.db
      .insert(notenbuchOfflineDevices)
      .values({ deviceId, userId, sessionId, serverShare: "x".repeat(43), expiresAt: new Date(t0.getTime() + 86_400_000) });
  }

  beforeAll(async () => {
    h = await createTestDb();
    await createUserWithPassword(h.db, { id: "lk", name: "Jana", username: "jana", role: "lehrkraft" }, { hash: "x" });
    await createUserWithPassword(h.db, { id: "vw", name: "Sabine", username: "sabine", role: "verwaltung" }, { hash: "x" });
  });
  afterAll(() => h.close());

  it("Einstellung je Schule; Aktivität frischt höchstens minütlich auf; abgelaufen beendet die Sitzung", async () => {
    await saveSecuritySettings(h.db, "vw", "schulnetz", { schoolNets: "", twoFactorFrom: "2026-12-01", idleMinutes: 30 });
    expect((await readSecuritySettings(h.db)).idleMinutes).toBe(30);
    await expect(saveSecuritySettings(h.db, "vw", "schulnetz", { schoolNets: "", twoFactorFrom: "2026-12-01", idleMinutes: 5 })).rejects.toThrow(
      "Stufe",
    );
    await session("a", "lk");
    expect(await sessionActivity(h.db, "a", 30, new Date(t0.getTime() + 20 * 60_000))).toBe("ok");
    const [r1] = await h.db.select().from(sessions).where(eq(sessions.id, "a"));
    expect(r1!.lastActiveAt?.getTime()).toBe(t0.getTime() + 20 * 60_000);
    // nach 45 min: noch innerhalb von 30 min seit der letzten Aktivität
    expect(await sessionActivity(h.db, "a", 30, new Date(t0.getTime() + 45 * 60_000))).toBe("ok");
    // nur prüfen (Live-Strom) frischt nicht auf
    expect(await sessionActivity(h.db, "a", 30, new Date(t0.getTime() + 70 * 60_000), false)).toBe("ok");
    expect(await sessionActivity(h.db, "a", 30, new Date(t0.getTime() + 80 * 60_000))).toBe("abgelaufen");
    expect(await h.db.select().from(sessions).where(eq(sessions.id, "a"))).toHaveLength(0);
    // aus: nie
    await session("b", "lk");
    expect(await sessionActivity(h.db, "b", 0, new Date(t0.getTime() + 5 * 86_400_000))).toBe("ok");
  });

  it("G4E-C01: offene Startseite (Tagesleiste lädt jede Minute neu) hält die Sitzung nicht wach – eine Eingabe schon", async () => {
    // Browser-Attrappe: document.cookie mit einem Cookie-Speicher, Uhr in Minuten
    const jar = new Map<string, string>();
    const doc = {
      get cookie() {
        return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      },
      set cookie(raw: string) {
        const [pair = ""] = raw.split(";");
        const [name = "", value = ""] = pair.split("=");
        if (raw.includes("max-age=0")) jar.delete(name);
        else jar.set(name, value);
      },
    };
    let now = t0.getTime();
    const tracker = activityTracker(doc, () => now);
    await session("auto", "lk");
    /** ein automatisches Neuladen (router.refresh – RSC-Anfrage, kein Seitenaufruf) */
    const autoRefresh = () => {
      tracker.beforeAutomatic();
      return requestActivity(h.db, "auto", 15, new Headers({ cookie: doc.cookie, "sec-fetch-mode": "cors" }), new Date(now));
    };
    // die Person arbeitet 5 Minuten (Eingaben), danach bleibt der Tab offen
    for (let m = 1; m <= 5; m++) {
      now = t0.getTime() + m * 60_000;
      tracker.input();
      expect(await autoRefresh()).toBe("ok");
    }
    let result: "ok" | "abgelaufen" = "ok";
    for (let m = 6; m <= 30 && result === "ok"; m++) {
      now = t0.getTime() + m * 60_000;
      result = await autoRefresh();
    }
    expect(result).toBe("abgelaufen");
    expect(now).toBeLessThanOrEqual(t0.getTime() + 21 * 60_000);
    // Live-Ereignis mit Herzschlag-Kopfzeile zählt ebenso nicht; ein Seitenaufruf (navigate) immer
    await session("auto2", "lk");
    const later = new Date(t0.getTime() + 10 * 60_000);
    expect(await requestActivity(h.db, "auto2", 15, new Headers({ "x-schulos-passiv": "1" }), later)).toBe("ok");
    expect((await h.db.select().from(sessions).where(eq(sessions.id, "auto2")))[0]!.lastActiveAt).toBeNull();
    expect(await requestActivity(h.db, "auto2", 15, new Headers({ cookie: "schulos_passiv=1", "sec-fetch-mode": "navigate" }), later)).toBe("ok");
    expect((await h.db.select().from(sessions).where(eq(sessions.id, "auto2")))[0]!.lastActiveAt).toEqual(later);
  });

  it("Inaktivität ist kein echtes Abmelden: der Notenbuch-Offline-Anteil bleibt (Q-5A-28)", async () => {
    await session("c", "lk");
    await offline("dev-c", "lk", "c");
    expect(await sessionActivity(h.db, "c", 15, new Date(t0.getTime() + 60 * 60_000))).toBe("abgelaufen");
    const [d] = await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, "dev-c"));
    expect(d?.sessionId).toBeNull();
  });

  it("Übersicht, anderes Gerät abmelden, überall abmelden (echtes Abmelden für alle Geräte)", async () => {
    await session("d", "lk", new Date(Date.now() - 60_000));
    await session("e", "lk", new Date(Date.now() - 30_000));
    await offline("dev-e", "lk", "e");
    const list = await listOwnSessions(h.db, "lk", "d");
    expect(list.find((s) => s.id === "d")).toMatchObject({ current: true, device: "Firefox auf Linux" });
    expect(list.find((s) => s.id === "e")).toMatchObject({ current: false, offline: true });
    expect(await endOwnSession(h.db, "lk", "d", "d")).toBe(false); // das eigene Gerät nicht hier
    expect(await endOwnSession(h.db, "vw", "e", "x")).toBe(false); // fremde Sitzung nicht
    expect(await endOwnSession(h.db, "lk", "e", "d")).toBe(true);
    expect(await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, "dev-e"))).toHaveLength(0);

    await session("f", "lk", new Date(Date.now() - 10_000));
    expect(await offlineDeviceCount(h.db, "lk")).toBe(1); // dev-c ohne Sitzung
    const r = await endAllOwnSessions(h.db, "lk", "d");
    expect(r.offline).toBe(1);
    expect((await h.db.select().from(sessions).where(eq(sessions.userId, "lk"))).map((s) => s.id)).toEqual(["d"]);
    expect(await offlineDeviceCount(h.db, "lk")).toBe(0);
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.action, "konto.sitzung.ueberall_abgemeldet"));
    expect(a?.target).toBe("lk");
  });
});
