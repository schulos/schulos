import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CTX, PRODUCTION } from "../fixtures";
import type { Answers } from "../questions";
import { App, type AppProps } from "./App";

const ENTER = "\r";
const DOWN = "\u001B[B";
const ESC = "\u001B";
const BACKSPACE = "\u007F";

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function setup(props: Partial<AppProps> = {}) {
  const onFinish = vi.fn<(a: Answers) => void>();
  const onAbort = vi.fn();
  const checkBackup = vi.fn<AppProps["checkBackup"]>(async () => ({ serverName: "Backup Musterstadt" }));
  const app = render(
    <App initial={{}} ctx={{ ...CTX, disks: CTX.disks!.slice(0, 1) }} mode="alle" checkBackup={checkBackup} onFinish={onFinish} onAbort={onAbort} charset="unicode" size={{ columns: 100, rows: 40 }} disclaimerAccepted {...props} />,
  );
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      app.stdin.write(k);
      await tick(k === ESC ? 80 : 25);
    }
  };
  const frame = () => app.lastFrame() ?? "";
  /** warten, bis die Ansicht da ist und ihre Tasten-Abfrage hängt (React registriert sie erst nach dem Zeichnen) */
  const view = async (text: string) => {
    for (let i = 0; i < 40 && !frame().includes(text); i++) await tick(25);
    expect(frame()).toContain(text);
    await tick(100);
  };
  return { app, press, frame, view, onFinish, onAbort, checkBackup };
}

let current: ReturnType<typeof setup> | null = null;
afterEach(() => {
  current?.app.unmount();
  current = null;
});

describe("Installer-Oberfläche", () => {
  it("REPO-03: Vorschau-Hinweis vor allen Fragen, weiter nur mit „VERSTANDEN“, Esc bricht ab", async () => {
    const t = (current = setup({ disclaimerAccepted: false }));
    await t.view("Vorschau-Software");
    expect(t.frame()).toContain("ohne Gewähr und ohne Support");
    expect(t.frame()).toContain("Verantwortlich für die Daten ist die Schule");
    expect(t.frame()).toContain("Penetrationstest");
    expect(t.frame()).not.toContain("Frage 1 von");
    await t.press(ENTER);
    expect(t.frame()).toContain("Bitte „VERSTANDEN“ eintippen");
    await t.view("Vorschau-Software");
    await t.press("ja", ENTER);
    expect(t.frame()).toContain("Bitte „VERSTANDEN“ eintippen");
    await t.view("Vorschau-Software");
    await t.press(" verstanden ", ENTER);
    await t.view("Frage 1 von");
    expect(t.frame()).toContain("Sprache");
    expect(t.onAbort).not.toHaveBeenCalled();

    const u = setup({ disclaimerAccepted: false });
    await u.view("Vorschau-Software");
    await u.press(ESC);
    expect(u.onAbort).toHaveBeenCalledOnce();
    u.app.unmount();
  });

  it("Demo-Hauptsystem: alle Fragen vorbelegt durchgehen, Passwort zweimal, Zusammenfassung, Installieren", async () => {
    const t = (current = setup());
    await tick();
    expect(t.frame()).toContain("Frage 1 von");
    expect(t.frame()).toContain("Sprache");
    await t.press(ENTER, ENTER, ENTER); // Sprache, Tastatur, Zeitzone
    expect(t.frame()).toContain("Rolle");
    await t.press(ENTER, ENTER); // Hauptsystem, Demo
    expect(t.frame()).toMatch(/\[x\] \/dev\/sda · 500 GB · Samsung SSD 870/);
    await t.press(ENTER, ENTER, ENTER, ENTER, ENTER, ENTER); // Platte, TPM2, Hostname, DHCP, kein Proxy, Schulnetz-Bereiche
    expect(t.frame()).toContain("Passwort für das Wartungskonto");
    await t.press("Wartung-im-Keller-2026", ENTER);
    expect(t.frame()).toContain("bitte wiederholen");
    expect(t.frame()).not.toContain("Wartung-im-Keller");
    await t.press("Wartung-im-Keller-2026", ENTER);
    await t.press(ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER); // SSH nein, Bildschirm, stabil, Fenster, Domain, eigene CA, nur Schulnetz, später koppeln
    expect(t.frame()).toContain("Zusammenfassung");
    expect(t.frame()).toMatch(/Instanztyp\s+Demo/);
    expect(t.frame()).toContain("••••••••");
    expect(t.frame()).toContain("/dev/sda wird vollständig gelöscht");
    expect(t.checkBackup).not.toHaveBeenCalled();
    await t.view("Installieren");
    await t.press(ENTER); // „Installieren“ ist vorausgewählt
    expect(t.onFinish).toHaveBeenCalledOnce();
    expect(t.onFinish.mock.calls[0]![0]).toMatchObject({
      role: "main",
      instance: "demo",
      "disk.devices": ["/dev/sda"],
      "access.password": "Wartung-im-Keller-2026",
      "access.ssh": false,
      "web.domain": "schulos.local",
      "backup.mode": "later",
    });
  });

  it("Prüfungen in der Oberfläche: zu kurzes Passwort, abweichende Wiederholung, Esc zurück, Löschen", async () => {
    // drei passende Platten → keine Vorgabe, die Platte muss gewählt werden
    const ctx = { ...CTX, disks: [...CTX.disks!.slice(0, 2), { path: "/dev/sdd", sizeBytes: 1024 ** 4, model: "WD Red" }] };
    const t = (current = setup({ initial: { role: "backup" }, mode: "fehlende", ctx }));
    await t.view("Zielplatte");
    await t.press(ENTER);
    expect(t.frame()).toContain("Mindestens eine Platte wählen");
    await t.press(" ", ENTER);
    expect(t.frame()).toContain("Passwort für das Wartungskonto");
    await t.press("kurz", ENTER);
    expect(t.frame()).toContain("Mindestens 12 Zeichen");
    await t.press("Wartung-im-Keller-2026", ENTER, "Wartung-im-Keller-2025", ENTER);
    expect(t.frame()).toContain("Wiederholung stimmt nicht überein");
    await t.press("Wartung-im-Keller-2026", ENTER, "Wartung-im-Keller-2026", ENTER);
    expect(t.frame()).toContain("Admin: Vorname");
    await t.press(ESC);
    expect(t.frame()).toContain("Passwort für das Wartungskonto");
    await t.press(ENTER); // leer = bisheriges Passwort behalten
    expect(t.frame()).toContain("Admin: Vorname");
    await t.press("Inaa", BACKSPACE, ENTER);
    expect(t.frame()).toContain("Admin: Nachname");
  });

  it("Backupserver nicht erreichbar → Meldung, „später koppeln“ übernimmt die Warnung in die Zusammenfassung", async () => {
    const checkBackup = vi.fn<AppProps["checkBackup"]>(async () => {
      throw new Error("Der Kopplungscode ist unbekannt, abgelaufen oder schon verwendet.");
    });
    const t = (current = setup({ initial: PRODUCTION, mode: "fehlende", ctx: CTX, checkBackup }));
    await t.view("Kopplungscode ist unbekannt");
    expect(checkBackup).toHaveBeenCalledWith("https://backup.gs-musterstadt.de", "k7q2 9mxa 4rt1");
    expect(t.frame()).toContain("Kopplungscode ist unbekannt");
    await t.press(DOWN, DOWN, ENTER); // später koppeln
    await t.view("Zusammenfassung");
    expect(t.frame()).toContain("Ohne Backup gehen bei einem Plattendefekt alle Daten verloren");
    await t.press(ENTER);
    expect(t.onFinish.mock.calls[0]![0]).toMatchObject({ "backup.mode": "later" });
    expect(t.onFinish.mock.calls[0]![0]["backup.code"]).toBeUndefined();
  });

  it("aus Backup wiederherstellen: bei fehlgeschlagener Prüfung kein „später koppeln“", async () => {
    const checkBackup = vi.fn<AppProps["checkBackup"]>(async () => {
      throw new Error("Der Kopplungscode ist unbekannt, abgelaufen oder schon verwendet.");
    });
    const t = (current = setup({ initial: { ...PRODUCTION, instance: "restore-backup" }, mode: "fehlende", ctx: CTX, checkBackup }));
    await t.view("Kopplungscode ist unbekannt");
    expect(t.frame()).toContain("gültigen Ersatz-Kopplungscode");
    expect(t.frame()).toContain("erneut prüfen");
    expect(t.frame()).not.toContain("später koppeln");
    await t.press(DOWN, DOWN, ENTER); // läuft über das Listenende zurück, nie zur Zusammenfassung
    expect(t.frame()).not.toContain("Installieren");
    expect(t.onFinish).not.toHaveBeenCalled();
  });

  it("Backupserver erreichbar → Name in der Zusammenfassung; Code ändern prüft neu; Abbrechen", async () => {
    const t = (current = setup({ initial: PRODUCTION, mode: "fehlende", ctx: CTX }));
    await t.view("Backupserver „Backup Musterstadt“ erreichbar");
    expect(t.checkBackup).toHaveBeenCalledOnce();
    // nach unten bis „Abbrechen“
    await t.press(DOWN, ENTER);
    expect(t.onAbort).toHaveBeenCalledOnce();
    expect(t.onFinish).not.toHaveBeenCalled();
  });

  it("Angabe in der Zusammenfassung ändern: danach zurück zur Zusammenfassung, neu geprüft", async () => {
    const t = (current = setup({ initial: { ...PRODUCTION, "backup.mode": "later" }, mode: "fehlende", ctx: CTX }));
    await t.view("Zusammenfassung");
    // erste Zeile („Sprache“) auswählen: von „Installieren“ einmal nach oben über alle Zeilen hinweg geht umständlich –
    // mit DOWN zweimal läuft die Auswahl über „Abbrechen“ zum Anfang der Liste
    await t.press(DOWN, DOWN, ENTER);
    await t.view("Frage 1 von");
    expect(t.frame()).toContain("Sprache");
    await t.press(ENTER);
    await t.view("Zusammenfassung");
  });

  it("80×25: Rahmen, Kopf mit Version, Schrittleiste, Fußzeile – nichts breiter oder höher", async () => {
    const t = (current = setup({ size: { columns: 80, rows: 25 }, version: "0.2.1" }));
    await t.view("Sprache");
    const lines = t.frame().split("\n");
    expect(lines).toHaveLength(25);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(80);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[1]).toContain("█▀▀ ▄▄▄ █▄▄");
    expect(lines[1]).toContain("Version 0.2.1");
    expect(lines[2]).toContain("Frage 1 von");
    expect(t.frame()).toContain("▶ Sprache & Region");
    expect(t.frame()).toContain("· Installation");
    expect(lines[23]).toContain("Enter weiter · Esc zurück");
    await t.press(ENTER, ENTER, ENTER);
    expect(t.frame()).toContain("✔ Sprache & Region");
    expect(t.frame()).toContain("▶ Rolle");
  });

  it("lange Auswahllisten (Bundesland) passen als Ausschnitt in 80×25", async () => {
    const t = (current = setup({ initial: { ...PRODUCTION, "backup.mode": "later" }, mode: "alle", ctx: CTX, size: { columns: 80, rows: 25 } }));
    await t.view("Sprache");
    // bis zum Bundesland vorspulen
    for (let i = 0; i < 40 && !t.frame().includes("Bundesland"); i++) await t.press(ENTER);
    await t.view("Bundesland");
    expect(t.frame()).toContain("Bundesland");
    expect(t.frame()).toMatch(/▼ \d+ weitere/);
    expect(t.frame().split("\n")).toHaveLength(25);
    await t.press(DOWN, DOWN, DOWN, DOWN); // von NW (10.) zu Sachsen-Anhalt (14.)
    expect(t.frame()).toMatch(/▲ \d+ weitere/);
    expect(t.frame()).toContain("› Sachsen-Anhalt");
    expect(t.frame().split("\n")).toHaveLength(25);
  });

  it("Linux-Konsole (TERM=linux): CP437-taugliche Zeichen, keine runden Ecken und kein ✔/▶", async () => {
    const t = (current = setup({ charset: "konsole", size: { columns: 80, rows: 25 } }));
    await t.view("Sprache");
    await t.press(ENTER, ENTER, ENTER);
    const f = t.frame();
    expect(f).toMatch(/^┌─+┐/);
    expect(f).toContain("√ Sprache & Region");
    expect(f).toContain("► Rolle");
    expect(f).toContain("» Hauptsystem");
    expect(f).toContain("Alt+F2 Konsole");
    expect(f).not.toMatch(/[✔▶╭╮╰╯›]/);
  });

  it("ohne UTF-8: nur ASCII für Rahmen, Marken und Logo", async () => {
    const t = (current = setup({ charset: "ascii", size: { columns: 80, rows: 25 } }));
    await t.view("Sprache");
    await t.press(ENTER, ENTER, ENTER);
    const f = t.frame();
    expect(f).toMatch(/^\+-+\+/);
    expect(f).toContain("+ Sprache & Region");
    expect(f).toContain("> Rolle");
    expect(f).toContain("> Hauptsystem");
    expect(f).toContain("SchulOS");
    expect(f).not.toMatch(/[█▀▄─│┌┐└┘√►»]/);
  });

  it("Zusammenfassung als Tabelle nach Abschnitten, in 80×25 mit Ausschnitt", async () => {
    const t = (current = setup({ initial: { ...PRODUCTION, "backup.mode": "later" }, mode: "fehlende", ctx: CTX, size: { columns: 80, rows: 25 } }));
    await t.view("Zusammenfassung");
    const f = t.frame();
    expect(f.split("\n")).toHaveLength(25);
    expect(f).toMatch(/Sprache & Region\s/);
    expect(f).toMatch(/Instanztyp\s+Produktiv \(leer\)/);
    expect(f).toMatch(/▼ \d+ weitere Zeilen/);
    expect(f).toContain("› Installieren");
    expect(f).toContain("/dev/sda wird vollständig gelöscht");
    await t.press(DOWN, DOWN); // über „Abbrechen“ zur ersten Zeile
    expect(t.frame()).toMatch(/› Sprache\s+Deutsch/);
    await t.press("[A", "[A", "[A"); // nach oben: über die Knöpfe ans Tabellenende
    expect(t.frame()).toMatch(/▲ \d+ weitere Zeilen/);
  });
});

