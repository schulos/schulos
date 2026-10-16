// REPO-03 (Projektleitung 2026-10-13): Vorschau-/Haftungshinweis – ein Text für den Installer (vor der Plattenauswahl, weiter nur mit
// „VERSTANDEN“) und die Web-Oberfläche (Bestätigung durch einen Admin beim Erststart, dauerhaft unter Verwaltung → System).
// Entfällt mit v1.0 nach dem Pilot.

export const DISCLAIMER_TITLE = "Vorschau-Software – bitte lesen";

export const DISCLAIMER_LINES = [
  "SchulOS ist Vorschau-Software: ohne Gewähr und ohne Support (AGPL-3.0, §§ 15–16).",
  "Verantwortlich für die Daten ist die Schule, die SchulOS betreibt (Verantwortliche nach DSGVO).",
  "Vor einem Echteinsatz fehlen noch: externer Penetrationstest, Klärung mit der bzw. dem Datenschutzbeauftragten der Schule, Pilotbetrieb.",
] as const;

/** Wort, das im Installer eingetippt werden muss */
export const DISCLAIMER_WORD = "VERSTANDEN";

/** Fassung des Textes – ändert er sich wesentlich, bestätigen Admins neu */
export const DISCLAIMER_VERSION = 1;

/** Eingabe im Installer: „VERSTANDEN“, Groß-/Kleinschreibung und Leerzeichen am Rand egal */
export function disclaimerConfirmed(input: string): boolean {
  return input.trim().toUpperCase() === DISCLAIMER_WORD;
}
