// Abschluss der interaktiven Installation (INST-01): nach dem bestätigten Wiederherstellungsschlüssel Kopplungscode,
// Startreihenfolge und die Frage „Neustart oder ausschalten“. Rein – main.tsx zeigt die Zeilen und schreibt die Entscheidung
// nach <ausgabe>/danach, start-installer.sh führt sie aus. Nie „Medium entfernen“, solange das Live-System davon läuft (INST-01);
// INST-06 (Q-INST05-1): ein eigener Konfigurations-Stick SCHULOSCFG wird ausgehängt und soll vor dem Neustart abgezogen werden.
import { formatGrubPassword } from "@schulos/server/boot-hardening";
import type { BootOrderResult } from "./system/boot-order";

export type After = "neustart" | "aus";

/** Datei im Ausgabeordner, die start-installer.sh nach dem Ende des Installers liest */
export const AFTER_FILE = "danach";

/** DS-14: Verantwortungshinweis am Ende jeder Installation – sachlich, ohne Zusagen. */
export const RESPONSIBILITY_NOTE =
  "Hinweis: SchulOS ist ein quelloffenes Lern- und Demoprojekt ohne Gewähr (AGPL-3.0, §§ 15–16). " +
  "Verantwortliche nach DSGVO ist die Schule, die SchulOS betreibt; SchulOS liefert Vorgaben und Vorlagen. " +
  "Vor dem Betrieb mit echten Daten die bzw. den Datenschutzbeauftragten der Schule einbinden.";

/**
 * Wo das Antworten-Laufwerk SCHULOSCFG liegt (start-installer.sh setzt SCHULOS_CFG_ORT): „stick“ = eigener Datenträger (darf vor
 * dem Neustart raus), „medium“ = auf dem Datenträger des Live-Systems (erst nach dem Neustart bzw. Ausschalten), null = keins.
 */
export type ConfigLocation = "stick" | "medium" | null;

export function configLocation(env: NodeJS.ProcessEnv): ConfigLocation {
  return env.SCHULOS_CFG_ORT === "stick" || env.SCHULOS_CFG_ORT === "medium" ? env.SCHULOS_CFG_ORT : null;
}

/**
 * INST-06: Hinweise vor dem Neustart-Tastendruck. Das Installationsmedium bleibt drin (das Live-System läuft davon, INST-01) – nach
 * dem Neustart startet dank Abschluss-Markierung und Vorgabe im Startmenü der ISO SchulOS von der Platte, sofern kein SCHULOSCFG
 * mehr steckt. Deshalb muss ein eigener Konfigurations-Stick JETZT raus (ausgehängt ist er schon). Bliebe er stecken, startet der
 * Installer – und der Überschreibschutz (system/existing.ts) bewahrt die fertige Installation.
 */
export function removeMediaLines(cfg: ConfigLocation): string[] {
  if (cfg === "medium")
    return [
      "  Das Konfigurations-Laufwerk SCHULOSCFG liegt auf dem Installationsmedium: das Medium nach dem Neustart",
      "  (bzw. bei ausgeschaltetem Rechner) entfernen – solange es steckt, startet das Startmenü wieder den Installer.",
      "",
    ];
  return [
    ...(cfg === "stick" ? ["  >>> Konfigurations-Stick (SCHULOSCFG) JETZT abziehen, dann die Taste drücken. <<<", ""] : []),
    "  Das Installationsmedium kann nach dem Neustart entfernt werden – bleibt es drin, startet SchulOS",
    "  automatisch von der Festplatte.",
    "",
  ];
}

/**
 * INST-07: Kennzeichnung im CI-Testmodus (Kernel-Parameter schulos.testmodus) – so sieht jede Ausgabe einer unbeaufsichtigten
 * Installation sofort, dass sie nicht von einer Schul-Installation stammt.
 */
export const TEST_INSTALL_NOTE = "TESTINSTALLATION (CI-Testmodus, Kernel-Parameter schulos.testmodus) – nicht für den Schulbetrieb.";

/** G4E-O04/O05 (Q-4E-61): Zeilen zum Bootmenü-Passwort – start-installer.sh schwärzt seriell die Zeile mit „Bootmenü-Passwort“ */
export const GRUB_PASSWORD_LABEL = "Bootmenü-Passwort (GRUB, Benutzer schulos)";
export function grubPasswordLines(pw: string): string[] {
  return [
    `  ${GRUB_PASSWORD_LABEL}: ${formatGrubPassword(pw)}`,
    "  Aufschreiben und zum Wiederherstellungsschlüssel legen – nötig für ältere Kernel, „Stand vor dem Versionswechsel“ und e/c",
    "  im Bootmenü. Dort ohne Leerzeichen eintippen (US-Tastatur; das Passwort enthält nur Zeichen, die auf beiden gleich liegen).",
    "",
  ];
}

/**
 * INST-12: eigener Bildschirm für das Bootmenü-Passwort nach dem Wiederherstellungsschlüssel – weiter erst, wenn die letzten
 * vier Zeichen eingetippt sind (Groß-/Kleinschreibung zählt, wie am GRUB-Prompt). So geht es nicht zwischen Kopplungscode
 * und Hinweisen unter.
 */
export const GRUB_CONFIRM_PROMPT = "  Tippe die letzten 4 Zeichen des Bootmenü-Passworts ein: ";
export function grubPasswordScreen(pw: string): string[] {
  return [
    "",
    "  BOOTMENÜ-PASSWORT – jetzt aufschreiben und zum Wiederherstellungsschlüssel legen:",
    "",
    `      ${formatGrubPassword(pw)}`,
    "",
    "  Benutzer im Bootmenü: schulos. Gebraucht für ältere Kernel, „Stand vor dem Versionswechsel“ und e/c im Bootmenü.",
    "  Dort ohne Leerzeichen eintippen (US-Tastatur; das Passwort enthält nur Zeichen, die auf beiden gleich liegen).",
    "  Ohne das Passwort lässt sich SchulOS im Notfall nicht über das Bootmenü starten.",
    "",
  ];
}
export function checkGrubConfirmation(pw: string, input: string): "ok" | "anzeigen" | "falsch" {
  const v = input.replace(/\s+/g, "");
  if (!v) return "anzeigen";
  return v === pw.slice(-4) ? "ok" : "falsch";
}

export function finalScreen(
  boot: BootOrderResult,
  pairingCode: string | null,
  cfg: ConfigLocation = null,
  testMode = false,
  grubPassword: string | null = null,
): { lines: string[]; prompt: string } {
  const lines = ["", ...(testMode ? [`  ${TEST_INSTALL_NOTE}`, ""] : []), "  Installation abgeschlossen.", ""];
  if (grubPassword) lines.push(...grubPasswordLines(grubPassword));
  // Backupserver: den ersten Code braucht der Installer des Hauptsystems (er wird beim ersten Start übernommen); weitere gibt es
  // in der Web-Oberfläche – das zeigt auch die Konsole nach dem Neustart (INST-05)
  if (pairingCode)
    lines.push(
      `  Kopplungscode für das Hauptsystem (24 h gültig): ${pairingCode}`,
      "  Später oder abgelaufen: Web-Oberfläche des Backupservers → „Instanzen“ → „Kopplungscode erzeugen“",
      "  (Adresse steht nach dem Neustart auf der Konsole).",
      "",
    );
  lines.push(`  ${RESPONSIBILITY_NOTE}`, "");
  if (boot.ok) {
    lines.push("  Startreihenfolge gesetzt: SchulOS startet als Erstes von der Platte.", "", ...removeMediaLines(cfg));
    return { lines, prompt: "  Enter = Neustart · a + Enter = ausschalten: " };
  }
  lines.push(
    `  Die Startreihenfolge ließ sich nicht setzen (${boot.reason}).`,
    "  Startet der Rechner später nicht von der Platte: im Boot-Menü der Firmware die Platte wählen.",
    "",
    ...removeMediaLines(cfg),
  );
  return { lines, prompt: "  Enter = ausschalten · n + Enter = trotzdem neu starten: " };
}

/**
 * Unbeaufsichtigt (CI, QEMU): Schlüssel und Kopplungscode als Zeilen – start-installer.sh schwärzt für die serielle
 * Schnittstelle die Zeile nach „WIEDERHERSTELLUNGSSCHLÜSSEL…“ und den Code hinter „Kopplungscode für das Hauptsystem“.
 */
export function summaryText(recoveryKey: string | null, pairingCode: string | null, testMode = false, grubPassword: string | null = null): string {
  let out = `${testMode ? `\n${TEST_INSTALL_NOTE}\n` : ""}\nInstallation abgeschlossen.\n`;
  if (recoveryKey)
    out += `\nWIEDERHERSTELLUNGSSCHLÜSSEL der Platte (aufschreiben und sicher verwahren – ohne ihn sind die Daten weg, wenn das TPM ausfällt):\n\n    ${recoveryKey}\n\n`;
  if (grubPassword) out += `${GRUB_PASSWORD_LABEL}: ${formatGrubPassword(grubPassword)}\n`;
  if (pairingCode) out += `Kopplungscode für das Hauptsystem (24 h gültig): ${pairingCode}\n`;
  out += `\n${RESPONSIBILITY_NOTE}\n`;
  return out;
}

/** Zeile für stdout (seriell) im Modus „konsole“ – kein Geheimnis; der QEMU-Test wartet darauf, bevor er Block 8 eintippt */
export const CONSOLE_WAIT_NOTE = "Warte an der Konsole (tty1) auf die Bestätigung des Wiederherstellungsschlüssels (Block 8) …";

/** Antwort auf die Frage aus `finalScreen` */
export function afterChoice(boot: BootOrderResult, answer: string): After {
  const a = answer.trim().toLowerCase();
  if (boot.ok) return a === "a" || a === "aus" ? "aus" : "neustart";
  return a === "n" || a === "neustart" ? "neustart" : "aus";
}

/**
 * Wie die Installation endet (INST-05): „bildschirm“ = Oberfläche auf stdin/stdout, „konsole“ = unbeaufsichtigt, aber Schlüssel
 * und Bestätigung direkt auf dem Terminal des Dienstes (tty1, /dev/tty – nicht über stdout, das seriell mitläuft), „zeilen“ =
 * Schlüssel nur als Zeile ohne Warten: nur mit dem Test-Schalter --ohne-bestaetigung bzw. ohne ISO-Ablauf (--plan im
 * Container-Test). Unbeaufsichtigt wartet also auch auf Block 8 und einen Tastendruck.
 */
export function endingFor(o: { interactiveTty: boolean; unattended: boolean; skipConfirmation: boolean }): "bildschirm" | "konsole" | "zeilen" {
  if (o.interactiveTty) return "bildschirm";
  if (o.unattended && !o.skipConfirmation) return "konsole";
  return "zeilen";
}
