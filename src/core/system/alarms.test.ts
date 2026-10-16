import { afterEach, describe, expect, it } from "vitest";
import type { MailMessage } from "@schulos/server/mail";
import type { SystemStatus } from "@schulos/server/system";
import type { BackupStatus } from "@/core/backup/status";
import { createTestDb } from "@/core/db/testing";
import type { DbHandle } from "@/core/db/client";
import { collectAlarms, runAlarms } from "./alarms";

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
  ...over,
});

describe("Alarme des Hauptsystems", () => {
  it("alles gut → keine Alarme", () => {
    expect(collectAlarms({ backup: okBackup, system: system(), now })).toEqual([]);
  });

  it("Backup, Update, Platz, Abgleich", () => {
    const keys = collectAlarms({
      backup: { ...okBackup, health: "overdue", lastOkAt: new Date("2026-10-03T01:30:00Z") },
      system: system({
        checkedAt: "2026-10-05T08:00:00Z",
        disk: { usedPercent: 94, freeBytes: 1e9 },
        protocol: [
          { at: "2026-10-05T02:40:00Z", step: "abbruch", ok: false, from: "1.4.2", to: "1.5.0", detail: "probelauf: Migration fehlgeschlagen" },
          { at: "2026-10-01T02:40:00Z", step: "fertig", ok: true, from: "1.4.1", to: "1.4.2" },
        ],
      }),
      now,
    }).map((a) => a.key);
    expect(keys).toEqual(["backup", "update:1.5.0", "platz", "abgleich"]);
    expect(collectAlarms({ backup: { ...okBackup, paired: false }, system: null, now }).map((a) => a.key)).toEqual(["backup:fehlt"]);
  });

  it("späteres gelungenes Update hebt den Alarm auf", () => {
    const s = system({
      protocol: [
        { at: "2026-10-05T03:00:00Z", step: "fertig", ok: true, from: "1.4.2", to: "1.5.0" },
        { at: "2026-10-05T02:40:00Z", step: "abbruch", ok: false, to: "1.5.0" },
      ],
    });
    expect(collectAlarms({ backup: okBackup, system: s, now })).toEqual([]);
  });

  it("Neustart mit Passphrase ausstehend (Q5-18): Alarm, ab 14 Tagen dringend", () => {
    const pending = system({ reboot: { since: "2026-09-30T02:30:00Z", reason: "passphrase" } });
    const [a] = collectAlarms({ backup: okBackup, system: pending, now });
    expect(a).toMatchObject({ key: "neustart", title: "Neustart nötig – Passphrase erforderlich" });
    expect(a!.detail).toContain("Jetzt neu starten");
    const [late] = collectAlarms({ backup: okBackup, system: pending, now: new Date("2026-10-15T10:00:00Z") });
    // Schlüssel bleibt gleich → keine „behoben“-Mail beim Wechsel auf dringend
    expect(late).toMatchObject({ key: "neustart", title: "Neustart seit 15 Tagen überfällig – Passphrase erforderlich" });
  });

  it("G4E-O03: TPM-Bindung unvollständig → Alarm (SEC-14); vollständig bzw. kein TPM2 → nichts", () => {
    const bad = system({ tpm: { problems: ["Secure Boot ist aus – die Platte ist nur an PCR 7 gebunden."] } });
    const [a] = collectAlarms({ backup: okBackup, system: bad, now });
    expect(a).toMatchObject({ key: "tpm", title: "TPM-Bindung der Platte unvollständig" });
    expect(a!.detail).toContain("Secure Boot ist aus");
    expect(collectAlarms({ backup: okBackup, system: system({ tpm: { problems: [] } }), now })).toEqual([]);
    expect(collectAlarms({ backup: okBackup, system: system({ tpm: null }), now })).toEqual([]);
  });

  let h: DbHandle | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("Durchgang: einmal senden, dann still, behoben melden; ohne SMTP nichts", async () => {
    h = await createTestDb();
    const sent: MailMessage[] = [];
    const config = { host: "smtp", port: 587, secure: false, user: null, password: null, from: "a@b.de", to: ["it@schule.de"] };
    const sender = async (m: MailMessage) => void sent.push(m);
    const bad = { ...okBackup, health: "failed" as const, lastRun: { trigger: "zeitplan" as const, status: "failed" as const, startedAt: "x", finishedAt: "x", error: "Backupserver nicht erreichbar" } };
    expect(await runAlarms(h.db, { config: null, backup: bad, system: system(), now })).toMatchObject({ sent: false });
    await runAlarms(h.db, { config, sender, backup: bad, system: system(), now });
    await runAlarms(h.db, { config, sender, backup: bad, system: system(), now: new Date("2026-10-05T10:15:00Z") });
    await runAlarms(h.db, { config, sender, backup: okBackup, system: system({ checkedAt: "2026-10-05T10:29:00Z" }), now: new Date("2026-10-05T10:30:00Z") });
    expect(sent.map((m) => m.subject)).toEqual(["[SchulOS] Backup fehlgeschlagen", "[SchulOS] behoben: Backup fehlgeschlagen"]);
    expect(sent[0]!.text).toContain("Backupserver nicht erreichbar");
  });
});
