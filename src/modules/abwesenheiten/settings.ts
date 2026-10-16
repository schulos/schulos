import { defineSetting } from "@/core/modules/settings";

/**
 * Hinweis an die Klassenleitung ab N Tagen mit unentschuldigten Fehlstunden im Halbjahr (Q5-13, I-22). Nur ein Hinweis –
 * keine automatische Meldung an Schulleitung oder Behörde; was daraus folgt, entscheiden Menschen.
 */
export const UNEXCUSED_HINT = defineSetting({
  key: "abwesenheiten.unexcused_hint",
  label: "Hinweis an die Klassenleitung bei unentschuldigten Fehltagen",
  help: "Die Klassenleitung bekommt einen Gong, sobald eine Schülerin oder ein Schüler im Halbjahr so viele Tage mit unentschuldigten Fehlstunden hat. Es geht keine Meldung an Schulleitung oder Behörden.",
  options: [
    { value: "0", label: "aus" },
    { value: "3", label: "ab 3 Tagen" },
    { value: "5", label: "ab 5 Tagen" },
    { value: "10", label: "ab 10 Tagen" },
    { value: "20", label: "ab 20 Tagen" },
  ],
  default: "5",
});

/**
 * Beurlaubung (Q5-16, F-08): bis zu dieser Zahl Schultage entscheidet die Klassenleitung, darüber die Schulleitung. Vorgabe 2
 * (§ 43 SchulG NRW – zu prüfen, DSB-FRAGEN §9); als Einstellung, damit eine abweichende Regelung ohne Codeänderung geht.
 */
export const LEAVE_CLASS_LEAD_DAYS = defineSetting({
  key: "abwesenheiten.leave_class_lead_days",
  label: "Beurlaubung: Klassenleitung entscheidet bis",
  help: "Längere Beurlaubungen entscheidet die Schulleitung (Recht „Beurlaubungen über der Grenze entscheiden“). Gezählt werden Schultage ohne Wochenenden, Feiertage und Ferien.",
  options: [
    { value: "0", label: "immer die Schulleitung" },
    { value: "1", label: "1 Schultag" },
    { value: "2", label: "2 Schultage" },
    { value: "3", label: "3 Schultage" },
    { value: "5", label: "5 Schultage" },
  ],
  default: "2",
});

/**
 * DS-16 (B05-KRANKMELDUNG.md): Gilt die Meldung über SchulOS als schriftliche Entschuldigung (§ 43 Abs. 2 SchulG NRW)? Ja →
 * die Meldungen sind Teil der Schülerakte und gehen als eigener Teil „Entschuldigungen“ in den Archivexport (5 Jahre, BASS
 * 12-51 Nr. 5 Nr. 3); im System bleiben sie bis zur Übergabe des Exports. Nein → Hinweis an die Eltern, zusätzlich schriftlich
 * zu entschuldigen; Löschung wie bisher zum Schuljahresende.
 */
export const DIGITAL_WRITTEN = defineSetting({
  key: "abwesenheiten.digital_written",
  label: "Digitale Meldung gilt als schriftliche Entschuldigung",
  help: "Ja: Meldungen über SchulOS ersetzen die schriftliche Entschuldigung; sie gehen als eigener Teil „Entschuldigungen“ in den Archivexport des Klassenbuchs (Aufbewahrung 5 Jahre) und werden im System erst gelöscht, wenn der Archivexport ihrer Klasse übergeben ist. Nein: Eltern werden gebeten, zusätzlich schriftlich zu entschuldigen.",
  options: [
    { value: "1", label: "ja – Archiv „Entschuldigungen“, 5 Jahre" },
    { value: "0", label: "nein – zusätzlich schriftlich" },
  ],
  default: "1",
});

export const ABWESENHEITEN_SETTINGS = [UNEXCUSED_HINT, LEAVE_CLASS_LEAD_DAYS, DIGITAL_WRITTEN];
