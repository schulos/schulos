import { afterEach, describe, expect, it } from "vitest";
import {
  alarmRecipients,
  planAlarms,
  type MailMessage,
} from "@schulos/server/mail";
import { ipKey, userKey } from "@schulos/server/throttle";
import type { SystemStatus } from "@schulos/server/system";
import type { BackupStatus } from "@/core/backup/status";
import type { DbHandle } from "@/core/db/client";
import { auditLog, authThrottle, mailOutbox } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { collectAlarms, runAlarms } from "./alarms";
import {
  AlarmSettingsError,
  failedLoginsLastHour,
  LOGIN_ALARM_DEFAULT,
  readAlarmSettings,
  rightsEvents,
  saveAlarmSettings,
  securityAlarms,
  THROTTLE_PREFIXES,
} from "./security-alarms";

const now = new Date("2026-10-14T10:00:00Z");
const okBackup: BackupStatus = {
  paired: true,
  health: "ok",
  lastOkAt: new Date("2026-10-14T01:30:00Z"),
  lastRun: null,
  contactError: null,
  lastContactAt: now,
  runningSince: null,
  restoreRequest: null,
  lastRestore: null,
};
const system: SystemStatus = {
  version: 1,
  checkedAt: "2026-10-14T09:58:00Z",
  current: "0.5.0",
  channel: "stabil",
  update: { status: "aktuell" },
  approved: null,
  protocol: [],
  os: null,
  disk: { usedPercent: 40, freeBytes: 1e11 },
};
const config = {
  host: "smtp",
  port: 587,
  secure: false,
  user: null,
  password: null,
  from: "schulos@schule.de",
  to: [] as string[],
};

let h: DbHandle | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("SEC-14: Ereignis-Alarme und Empfänger (@schulos/server/mail)", () => {
  it("Ereignis: einmal melden, nicht erinnern, kein „behoben“; Zustände wie bisher", () => {
    const ev = {
      key: "rechte:7",
      title: "Neue Admin-Rechte",
      detail: "d",
      event: true,
    };
    const p1 = planAlarms([ev], {}, now);
    expect(p1.send.map((a) => a.key)).toEqual(["rechte:7"]);
    const later = new Date(now.getTime() + 30 * 3600_000);
    const p2 = planAlarms([ev], p1.next, later);
    expect(p2.send).toEqual([]);
    const p3 = planAlarms([], p2.next, later);
    expect(p3.resolved).toEqual([]);
    expect(p3.next).toEqual({});
  });

  it("Empfänger aus Umgebung und Verwaltung, ohne Doppelte und Unsinn", () => {
    expect(
      alarmRecipients(
        ["it@schule.de"],
        ["IT@schule.de", "sl@schule.de", "kaputt"],
      ),
    ).toEqual(["it@schule.de", "sl@schule.de"]);
  });
});

describe("SEC-14: Sicherheitsalarme des Hauptsystems", () => {
  it("Fehl-Anmeldungen: Schwelle, Entprellung über die halbe Schwelle, nur Anzahl im Text", () => {
    expect(
      securityAlarms({
        failedLogins: 49,
        threshold: 50,
        loginAlarmActive: false,
        rights: [],
      }),
    ).toEqual([]);
    const [a] = securityAlarms({
      failedLogins: 50,
      threshold: 50,
      loginAlarmActive: false,
      rights: [],
    });
    expect(a).toMatchObject({
      key: "anmeldung:haeufung",
      title: expect.stringContaining("50 in der letzten Stunde"),
    });
    expect(a!.event).toBeUndefined();
    // läuft schon: bleibt bis unter 25
    expect(
      securityAlarms({
        failedLogins: 25,
        threshold: 50,
        loginAlarmActive: true,
        rights: [],
      }),
    ).toHaveLength(1);
    expect(
      securityAlarms({
        failedLogins: 24,
        threshold: 50,
        loginAlarmActive: true,
        rights: [],
      }),
    ).toEqual([]);
  });

  it("Zähler aus der Anmeldesperre: letzte Stunde, je Name bzw. Adresse, der größere zählt", async () => {
    h = await createTestDb();
    expect(
      THROTTLE_PREFIXES.map((p) => [
        userKey("x").startsWith(p),
        ipKey("1.2.3.4").startsWith(p),
      ]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
    const recent = new Date(now.getTime() - 10 * 60_000);
    const old = new Date(now.getTime() - 2 * 3600_000);
    await h.db.insert(authThrottle).values([
      {
        key: userKey("lea"),
        failures: 4,
        windowStartedAt: recent,
        updatedAt: recent,
      },
      {
        key: userKey("jana"),
        failures: 3,
        windowStartedAt: recent,
        updatedAt: recent,
      },
      {
        key: ipKey("203.0.113.9"),
        failures: 30,
        windowStartedAt: recent,
        updatedAt: recent,
      },
      {
        key: ipKey("198.51.100.1"),
        failures: 99,
        windowStartedAt: old,
        updatedAt: old,
      },
    ]);
    expect(await failedLoginsLastHour(h.db, now)).toBe(30);
  });

  it("neue Admin-/Verwaltungsrechte der letzten 24 h als Ereignis; andere Rechte nicht", async () => {
    h = await createTestDb();
    const at = new Date(now.getTime() - 3600_000);
    await h.db.insert(auditLog).values([
      {
        action: "verwaltung.rights.grant",
        target: "role:lehrkraft",
        meta: { permission: "verwaltung.users" },
        createdAt: at,
      },
      {
        action: "verwaltung.rights.grant",
        target: "group:g1",
        meta: { permission: "*" },
        createdAt: at,
      },
      {
        action: "verwaltung.rights.grant",
        target: "role:lehrkraft",
        meta: { permission: "messenger.write" },
        createdAt: at,
      },
      {
        action: "verwaltung.user.create",
        target: "u1",
        meta: { role: "admin" },
        createdAt: at,
      },
      {
        action: "verwaltung.user.create",
        target: "u2",
        meta: { role: "lehrkraft" },
        createdAt: at,
      },
      {
        action: "verwaltung.rights.grant",
        target: "role:sekretariat",
        meta: { permission: "verwaltung.users" },
        createdAt: new Date(now.getTime() - 30 * 3600_000),
      },
    ]);
    const ev = await rightsEvents(h.db, now);
    expect(ev.map((e) => e.text)).toEqual([
      "Recht „verwaltung.users“ an Rolle lehrkraft vergeben",
      "Recht „*“ an eine Gruppe vergeben",
      "Konto mit Rolle admin angelegt",
    ]);
    const alarms = securityAlarms({
      failedLogins: 0,
      threshold: 50,
      loginAlarmActive: false,
      rights: ev,
    });
    expect(alarms.every((a) => a.event && a.key.startsWith("rechte:"))).toBe(
      true,
    );
  });

  it("Einstellungen: Empfänger und Schwelle prüfen, Vorgabe 50, Änderung im Protokoll", async () => {
    h = await createTestDb();
    expect(await readAlarmSettings(h.db)).toEqual({
      recipients: [],
      loginThreshold: LOGIN_ALARM_DEFAULT,
    });
    await expect(
      saveAlarmSettings(h.db, null as unknown as string, {
        recipients: "kein-mail",
        loginThreshold: "50",
      }),
    ).rejects.toThrow(AlarmSettingsError);
    await expect(
      saveAlarmSettings(h.db, null as unknown as string, {
        recipients: "",
        loginThreshold: "2",
      }),
    ).rejects.toThrow("Schwelle");
    await saveAlarmSettings(h.db, null as unknown as string, {
      recipients: "it@schule.de; sl@schule.de",
      loginThreshold: "20",
    });
    expect(await readAlarmSettings(h.db)).toEqual({
      recipients: ["it@schule.de", "sl@schule.de"],
      loginThreshold: 20,
    });
  });

  it("G4E-O12: Änderung meldet sich bei alten und neuen Empfängern; leere Liste nur mit SCHULOS_ALARM_TO", async () => {
    h = await createTestDb();
    await saveAlarmSettings(h.db, null as unknown as string, { recipients: "it@schule.de, sl@schule.de", loginThreshold: "50" }, {});
    await h!.db.delete(mailOutbox);
    // ohne SCHULOS_ALARM_TO darf die Liste nicht leer werden
    await expect(saveAlarmSettings(h.db, null as unknown as string, { recipients: "", loginThreshold: "50" }, {})).rejects.toThrow("Mindestens ein Empfänger");
    // Angreifer stellt um: nur noch eine fremde Adresse, Schwelle hoch → Mail an die bisherigen UND die neue Adresse
    await saveAlarmSettings(h.db, null as unknown as string, { recipients: "fremd@example.org", loginThreshold: "10000" }, {});
    const mails = await h.db.select().from(mailOutbox);
    expect(mails.map((m) => m.to).sort()).toEqual(["fremd@example.org", "it@schule.de", "sl@schule.de"]);
    expect(mails[0]!.subject).toBe("[SchulOS] Alarm-Einstellungen geändert");
    expect(mails[0]!.text).toContain("vorher 50, jetzt 10000");
    expect(mails[0]!.text).toContain("mindestens einer entfernt");
    expect(mails[0]!.text).not.toContain("it@schule.de");
    // mit SCHULOS_ALARM_TO ist die leere Liste erlaubt (Mail auch an die Umgebung)
    await h!.db.delete(mailOutbox);
    await saveAlarmSettings(h.db, null as unknown as string, { recipients: "", loginThreshold: "50" }, { SCHULOS_ALARM_TO: "it-leitung@schule.de" });
    expect((await h.db.select().from(mailOutbox)).map((m) => m.to).sort()).toEqual(["fremd@example.org", "it-leitung@schule.de"]);
    // unverändert gespeichert → keine Mail
    await h!.db.delete(mailOutbox);
    await saveAlarmSettings(h.db, null as unknown as string, { recipients: "", loginThreshold: "50" }, { SCHULOS_ALARM_TO: "it-leitung@schule.de" });
    expect(await h.db.select().from(mailOutbox)).toEqual([]);
  });

  it("unveränderliche Kopie veraltet/fehlt → Alarm; nicht eingerichtet → keiner", () => {
    const im = (lastAt: string | null, ok = true) => ({
      ...okBackup,
      immutable: {
        lastAt,
        checkedAt: "2026-10-13T16:00:00Z",
        ok,
        error: ok ? null : "zu alt",
      },
    });
    expect(collectAlarms({ backup: okBackup, system, now })).toEqual([]);
    expect(
      collectAlarms({ backup: im("2026-10-13T01:00:00Z"), system, now }),
    ).toEqual([]);
    expect(
      collectAlarms({
        backup: im("2026-10-10T01:00:00Z", false),
        system,
        now,
      }).map((a) => a.title),
    ).toEqual(["Unveränderliche Backup-Kopie veraltet"]);
    expect(
      collectAlarms({ backup: im(null, false), system, now }).map((a) => a.key),
    ).toEqual(["unveraenderlich"]);
  });

  it("Durchgang: Empfänger nur aus der Verwaltung reichen; Rechte-Ereignis genau einmal; ohne Empfänger keine Mail", async () => {
    h = await createTestDb();
    const sent: MailMessage[] = [];
    const sender = async (m: MailMessage) => void sent.push(m);
    expect(
      await runAlarms(h.db, { config, sender, backup: okBackup, system, now }),
    ).toMatchObject({ sent: false, reason: "keine Empfänger" });
    await saveAlarmSettings(h.db, null as unknown as string, {
      recipients: "it@schule.de",
      loginThreshold: "50",
    });
    await h.db
      .insert(auditLog)
      .values({
        action: "verwaltung.rights.grant",
        target: "role:lehrkraft",
        meta: { permission: "*" },
        createdAt: now,
      });
    await runAlarms(h.db, { config, sender, backup: okBackup, system, now });
    await runAlarms(h.db, {
      config,
      sender,
      backup: okBackup,
      system,
      now: new Date(now.getTime() + 15 * 60_000),
    });
    // nach dem 24-h-Fenster: still verschwunden, kein „behoben“
    await runAlarms(h.db, {
      config,
      sender,
      backup: okBackup,
      system,
      now: new Date(now.getTime() + 25 * 3600_000),
    });
    // (nach 25 h melden sich Backup/Abgleich der Testdaten – hier zählt nur das Rechte-Ereignis)
    expect(sent.filter((m) => m.text.includes("Neue Admin-/Verwaltungsrechte"))).toHaveLength(1);
    expect(sent.some((m) => m.subject.includes("behoben") && m.text.includes("Admin"))).toBe(false);
    expect(sent[0]!.to).toEqual(["it@schule.de"]);
    expect(sent[0]!.subject).toContain(
      "Neue Admin-/Verwaltungsrechte: Recht „*“ an Rolle lehrkraft vergeben",
    );
  });
});
