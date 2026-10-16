import { describe, expect, it } from "vitest";
import { alarmMessage, isMailAddress, mailConfig, planAlarms, safeMailConfig, testMessage } from "./mail";

describe("isMailAddress", () => {
  it("einfache Prüfung", () => {
    expect(isMailAddress("eltern@example.org")).toBe(true);
    for (const bad of ["", "a@b", "a b@c.de", "<a@b.de>", `${"x".repeat(250)}@b.de`]) expect(isMailAddress(bad)).toBe(false);
  });
});

const base = { SCHULOS_SMTP_HOST: "smtp.schule.de", SCHULOS_SMTP_FROM: "SchulOS <schulos@schule.de>", SCHULOS_ALARM_TO: "it@schule.de, sl@schule.de" };

describe("SMTP-Konfiguration", () => {
  it("ohne Host keine Mails; Vorgaben und TLS je Port", () => {
    expect(mailConfig({})).toBeNull();
    expect(mailConfig(base)).toEqual({ host: "smtp.schule.de", port: 587, secure: false, user: null, password: null, from: "SchulOS <schulos@schule.de>", to: ["it@schule.de", "sl@schule.de"] });
    expect(mailConfig({ ...base, SCHULOS_SMTP_PORT: "465", SCHULOS_SMTP_USER: "u", SCHULOS_SMTP_PASSWORD: "p" })).toMatchObject({ secure: true, user: "u", password: "p" });
  });

  it("verständliche Fehler", () => {
    expect(() => mailConfig({ SCHULOS_SMTP_HOST: "x", SCHULOS_SMTP_PORT: "abc", SCHULOS_ALARM_TO: "kein-mail" })).toThrow(
      /SMTP_PORT[\s\S]*SMTP_FROM[\s\S]*„kein-mail“/,
    );
  });

  it("Transaktionsmails (P4-30): ohne Alarm-Empfänger zulässig, ungültige Empfänger bleiben ein Fehler", () => {
    const noAlarm = { SCHULOS_SMTP_HOST: base.SCHULOS_SMTP_HOST, SCHULOS_SMTP_FROM: base.SCHULOS_SMTP_FROM };
    expect(() => mailConfig(noAlarm)).toThrow(/SCHULOS_ALARM_TO/);
    expect(mailConfig(noAlarm, { alarmTo: false })).toMatchObject({ host: "smtp.schule.de", to: [] });
    expect(() => mailConfig({ ...base, SCHULOS_ALARM_TO: "kaputt" }, { alarmTo: false })).toThrow(/„kaputt“/);
  });
});

describe("SMTP-Konfiguration für Jobs (safeMailConfig)", () => {
  it("fehlerhafte Angaben: protokolliert, keine Mail statt Abbruch", () => {
    const log: string[] = [];
    expect(safeMailConfig({ ...base, SCHULOS_ALARM_TO: "kaputt" }, (m) => log.push(m))).toBeNull();
    expect(log[0]).toMatch(/SMTP-Konfiguration fehlerhaft: E-Mail-Einstellungen unvollständig/);
    expect(safeMailConfig(base, (m) => log.push(m))?.host).toBe("smtp.schule.de");
    expect(safeMailConfig({}, (m) => log.push(m))).toBeNull();
    expect(log).toHaveLength(1);
  });
});

describe("Alarme", () => {
  const t0 = new Date("2026-10-05T08:00:00Z");
  const backup = { key: "backup:lindenhof", title: "Backup überfällig: Lindenhof", detail: "Seit 30 Stunden keine Sicherung." };
  const disk = { key: "platz", title: "Speicherplatz knapp (93 %)", detail: "Platte erweitern." };

  it("neu → senden; besteht → erst nach 24 h erinnern; weg → behoben", () => {
    const p1 = planAlarms([backup], {}, t0);
    expect(p1.send).toEqual([{ ...backup, reminder: false }]);
    const p2 = planAlarms([backup, disk], p1.next, new Date("2026-10-05T12:00:00Z"));
    expect(p2.send.map((a) => a.key)).toEqual(["platz"]);
    expect(p2.next["backup:lindenhof"]!.since).toBe(t0.toISOString());
    const p3 = planAlarms([backup], p2.next, new Date("2026-10-06T08:00:00Z"));
    expect(p3.send).toEqual([{ ...backup, reminder: true }]);
    expect(p3.resolved).toEqual([{ key: "platz", title: "Speicherplatz knapp (93 %)" }]);
    expect(p3.next).not.toHaveProperty("platz");
  });

  it("eine Mail je Durchgang, nichts zu tun → keine Mail", () => {
    const m = alarmMessage("SchulOS Backup", { send: [{ ...backup, reminder: false }], resolved: [{ key: "platz", title: "Speicherplatz knapp" }] }, ["it@schule.de"]);
    expect(m?.subject).toBe("[SchulOS Backup] Backup überfällig: Lindenhof");
    expect(m?.text).toContain("Seit 30 Stunden keine Sicherung.");
    expect(m?.text).toContain("Wieder in Ordnung:");
    expect(alarmMessage("x", { send: [], resolved: [] }, [])).toBeNull();
    expect(alarmMessage("x", { send: [], resolved: [{ key: "a", title: "A" }] }, [])?.subject).toBe("[x] behoben: A");
    expect(testMessage("SchulOS", ["a@b.de"]).subject).toBe("[SchulOS] Testnachricht");
  });
});
