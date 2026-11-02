import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SystemStatus } from "@schulos/server/system";
import { createUserWithPassword } from "@/core/auth/auth";
import type { BackupStatus } from "@/core/backup/status";
import type { DbHandle } from "@/core/db/client";
import { systemJobs } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { collectHealth } from "./health";
import { HEALTH_TOKEN_FILE, healthAccess, parseHealthSettings, readHealthSettings, readHealthToken, rotateHealthToken, saveHealthSettings, tokenMatches } from "./health-settings";

const now = new Date("2026-10-05T10:00:00Z");
const okBackup: BackupStatus = {
  paired: true,
  health: "ok",
  lastOkAt: new Date("2026-10-05T01:30:00Z"),
  lastRun: null,
  contactError: null,
  lastContactAt: now,
  runningSince: null,
  restoreRequest: null,
  lastRestore: null,
};
const system = (over: Partial<SystemStatus> = {}): SystemStatus => ({
  version: 1,
  checkedAt: "2026-10-05T09:58:00Z",
  current: "1.4.2",
  channel: "stabil",
  update: { status: "aktuell" },
  approved: null,
  protocol: [],
  os: null,
  disk: { usedPercent: 40, freeBytes: 1e11 },
  tls: { expiresAt: "2027-01-01T00:00:00Z" },
  ...over,
});
const noMail = { pending: 0, sent: 5, failed: 0, oldestPending: null };

describe("collectHealth (BM-01)", () => {
  let h: DbHandle;
  let dir: string;
  beforeEach(async () => {
    h = await createTestDb();
    dir = mkdtempSync(path.join(tmpdir(), "schulos-health-"));
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  });

  it("alles gut → Stufe ok, Kennzahlen gefüllt", async () => {
    const r = await collectHealth(h.db, { system: system(), backup: okBackup, now, version: "1.4.2", outbox: noMail, mailConfigured: true });
    expect(r).toMatchObject({
      version: 1,
      level: "ok",
      problems: [],
      app: { version: "1.4.2", channel: "stabil" },
      database: { ok: true },
      mail: { configured: true, pending: 0, failed: 0, oldestPendingMinutes: null },
      backup: { paired: true, health: "ok", ageHours: 8.5, offsite: "aus" },
      disk: { usedPercent: 40 },
      tls: { expiresAt: "2027-01-01T00:00:00Z", daysLeft: 87 },
      host: { stale: false, rebootPending: false },
    });
    expect(r.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("ohne Host-Status (Entwicklung): nur App-Seite, keine Host-Befunde", async () => {
    const r = await collectHealth(h.db, { system: null, backup: okBackup, now, outbox: noMail });
    expect(r).toMatchObject({ level: "ok", disk: null, tls: null, host: null });
  });

  it("Mail-Stau und fehlgeschlagene Mails; Schwelle einstellbar", async () => {
    const stuck = { pending: 7, sent: 0, failed: 2, oldestPending: new Date("2026-10-05T08:30:00Z") };
    const r = await collectHealth(h.db, { system: system(), backup: okBackup, now, outbox: stuck });
    expect(r.level).toBe("warn");
    expect(r.problems.map((p) => p.key)).toEqual(["mail:stau", "mail:fehlgeschlagen"]);
    expect(r.mail.oldestPendingMinutes).toBe(90);
    const lax = await collectHealth(h.db, { system: system(), backup: okBackup, now, outbox: stuck, settings: { mode: "schulnetz", mailBacklogMinutes: 120, backupMaxHours: 26 } });
    expect(lax.problems.map((p) => p.key)).toEqual(["mail:fehlgeschlagen"]);
  });

  it("Jobs: fehlgeschlagener Lauf wird gemeldet, Fehlertext von Adressen bereinigt", async () => {
    await h.db.insert(systemJobs).values([
      { name: "loeschlauf", lastStartedAt: now, lastFinishedAt: now, lastStatus: "ok" },
      { name: "ferien", lastStartedAt: now, lastFinishedAt: now, lastStatus: "failed", lastError: "Mail an anna.muster@schule.de gescheitert" },
    ]);
    const r = await collectHealth(h.db, { system: system(), backup: okBackup, now, outbox: noMail });
    expect(r.jobs.map((j) => j.name)).toEqual(["ferien", "loeschlauf"]);
    expect(r.jobs[0]!.error).toBe("Mail an <adresse> gescheitert");
    expect(r.problems).toEqual([{ level: "warn", key: "job:ferien", text: "Job ferien: letzter Lauf fehlgeschlagen" }]);
    expect(JSON.stringify(r)).not.toContain("anna.muster");
  });

  it("Sicherung: nicht eingerichtet (Warnung), überfällig/fehlgeschlagen (Fehler), älter als Schwelle (Warnung), Offsite veraltet", async () => {
    const run = (backup: BackupStatus, backupMaxHours = 26) =>
      collectHealth(h.db, { system: system(), backup, now, outbox: noMail, settings: { mode: "schulnetz", mailBacklogMinutes: 60, backupMaxHours } });
    expect((await run({ ...okBackup, paired: false, health: "none", lastOkAt: null })).problems).toEqual([{ level: "warn", key: "backup:fehlt", text: "Keine Sicherung eingerichtet" }]);
    expect((await run({ ...okBackup, health: "overdue" })).level).toBe("error");
    expect((await run({ ...okBackup, health: "failed" })).level).toBe("error");
    expect((await run(okBackup, 6)).problems.map((p) => p.key)).toEqual(["backup:alt"]);
    const stale = { ...okBackup, immutable: { ok: true, lastAt: "2026-09-01T00:00:00Z", checkedAt: "2026-10-05T09:00:00Z", error: null } } as unknown as BackupStatus;
    const r = await run(stale);
    expect(r.backup.offsite).toBe("veraltet");
    expect(r.problems.map((p) => p.key)).toEqual(["unveraenderlich"]);
  });

  it("Platte, Zertifikat, Neustart, Abgleich, fehlgeschlagenes Update", async () => {
    const r = await collectHealth(h.db, {
      system: system({
        checkedAt: "2026-10-05T08:00:00Z",
        disk: { usedPercent: 98, freeBytes: 1e8 },
        tls: { expiresAt: "2026-10-12T00:00:00Z" },
        reboot: { since: "2026-09-01T00:00:00Z", reason: "passphrase" },
        protocol: [{ at: "2026-10-05T02:40:00Z", step: "abbruch", ok: false, to: "1.5.0" }],
      }),
      backup: okBackup,
      now,
      outbox: noMail,
    });
    expect(r.level).toBe("error");
    expect(Object.fromEntries(r.problems.map((p) => [p.key, p.level]))).toEqual({ platz: "error", zertifikat: "warn", abgleich: "warn", neustart: "error", update: "warn" });
    expect(r.tls?.daysLeft).toBe(6);
    const expired = await collectHealth(h.db, { system: system({ tls: { expiresAt: "2026-10-01T00:00:00Z" } }), backup: okBackup, now, outbox: noMail });
    expect(expired.problems).toEqual([{ level: "error", key: "zertifikat", text: "Zertifikat ist abgelaufen" }]);
  });

  it("Datenbank nicht erreichbar → Fehler, kein Absturz", async () => {
    const broken = { execute: async () => Promise.reject(new Error("connection refused")) } as unknown as typeof h.db;
    const r = await collectHealth(broken, { system: null, backup: okBackup, now, outbox: noMail });
    expect(r.level).toBe("error");
    expect(r.database).toEqual({ ok: false, latencyMs: null });
    expect(r.problems[0]).toMatchObject({ key: "datenbank" });
  });

  it("Bericht enthält nur die vorgesehenen Felder (Struktur eingefroren)", async () => {
    const r = await collectHealth(h.db, { system: system(), backup: okBackup, now, outbox: noMail });
    expect(Object.keys(r).sort()).toEqual(["app", "backup", "checkedAt", "database", "disk", "host", "jobs", "level", "mail", "problems", "tls", "version"]);
  });

  describe("Einstellungen und Zugang (BM-02)", () => {
    it("Vorgabe: Schulnetz; ungültige Werte fallen zurück", async () => {
      expect((await readHealthSettings(h.db)).mode).toBe("schulnetz");
      expect(parseHealthSettings({ mode: "alle", mailBacklogMinutes: 1, backupMaxHours: "x" })).toEqual({ mode: "schulnetz", mailBacklogMinutes: 60, backupMaxHours: 26 });
    });

    it("speichern prüft, protokolliert und legt für Token ein Token an", async () => {
      await createUserWithPassword(h.db, { id: "u-admin", name: "Admin", username: "admin", role: "admin" }, { hash: "x" });
      await expect(saveHealthSettings(h.db, "u-admin", { mode: "alle", mailBacklogMinutes: "60", backupMaxHours: "26" }, dir)).rejects.toThrow("Betriebsart");
      await expect(saveHealthSettings(h.db, "u-admin", { mode: "token", mailBacklogMinutes: "1", backupMaxHours: "26" }, dir)).rejects.toThrow("Mail-Stau");
      await expect(saveHealthSettings(h.db, "u-admin", { mode: "token", mailBacklogMinutes: "60", backupMaxHours: "1000" }, dir)).rejects.toThrow("Sicherung");
      expect(readHealthToken(dir)).toBeNull();
      const s = await saveHealthSettings(h.db, "u-admin", { mode: "token", mailBacklogMinutes: "30", backupMaxHours: "48" }, dir);
      expect(s).toEqual({ mode: "token", mailBacklogMinutes: 30, backupMaxHours: 48 });
      expect(await readHealthSettings(h.db)).toEqual(s);
      const t = readHealthToken(dir)!;
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // erneuern: neues Token, das alte gilt nicht mehr
      const t2 = await rotateHealthToken(h.db, "u-admin", dir);
      expect(t2).not.toBe(t);
      expect(readHealthToken(dir)).toBe(t2);
      if (process.platform !== "win32") expect(statSync(path.join(dir, HEALTH_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    });

    it("Zugang: aus → nie; Schulnetz → nur Schulnetz; Token → nur mit richtigem Bearer-Token", () => {
      const token = "a".repeat(43);
      const base = { authorization: null, token: null };
      expect(healthAccess({ ...base, mode: "aus", zone: "schulnetz" })).toBe(false);
      expect(healthAccess({ ...base, mode: "schulnetz", zone: "schulnetz" })).toBe(true);
      expect(healthAccess({ ...base, mode: "schulnetz", zone: "aussen" })).toBe(false);
      // im Modus Schulnetz hilft auch ein Token von außen nichts
      expect(healthAccess({ mode: "schulnetz", zone: "aussen", authorization: `Bearer ${token}`, token })).toBe(false);
      expect(healthAccess({ mode: "token", zone: "aussen", authorization: `Bearer ${token}`, token })).toBe(true);
      expect(healthAccess({ mode: "token", zone: "schulnetz", authorization: null, token })).toBe(false);
      expect(healthAccess({ mode: "token", zone: "schulnetz", authorization: "Bearer falsch", token })).toBe(false);
      // ohne gespeichertes Token nie
      expect(healthAccess({ mode: "token", zone: "schulnetz", authorization: "Bearer x", token: null })).toBe(false);
      expect(tokenMatches(`Basic ${token}`, token)).toBe(false);
      expect(tokenMatches(`bearer ${token}`, token)).toBe(true);
    });
  });
});
