import { defineSetting } from "@/core/modules/settings";
import { LABEL_FORMATS } from "@/core/etiketten/codes";
import { INVENTORY_NO_FORMAT_LABELS, INVENTORY_NO_FORMATS } from "./labels";

/**
 * Aufbewahrung der Prüfprotokolle (Q5-26, G4-01): wie viele Protokolle (PDF + Bemerkung) je Prüfart und Ziel bleiben.
 * Ältere leert der Löschlauf, frühestens ein Jahr nach der Prüfung. Vorgabe „letzte 2“ = bis zur übernächsten Prüfung.
 * Der Wert ist die Zahl späterer erledigter Prüfungen, ab der geleert wird (Löschkonzept: `{setting}` im Manifest).
 */
export const REPORT_KEEP = defineSetting({
  key: "gebaeude.report_keep",
  label: "Prüfprotokolle aufbewahren",
  help: "Ältere Protokolle (PDF und Bemerkung) leert der Löschlauf, frühestens ein Jahr nach der Prüfung; Termin, Ergebnis und Firma bleiben als Nachweis.",
  options: [
    { value: "2", label: "letzte 2 Protokolle (bis zur übernächsten Prüfung)" },
    { value: "3", label: "letzte 3 Protokolle" },
    { value: "5", label: "letzte 5 Protokolle" },
  ],
  default: "2",
});

/** INV-01: Aufbau automatischer Inventarnummern (Präfix der Kategorie + laufende Nummer). */
export const INVENTORY_NO_FORMAT = defineSetting({
  key: "gebaeude.inventory_no_format",
  label: "Inventarnummern",
  help: "Aufbau der automatisch vergebenen Inventarnummern; von Hand oder per CSV vergebene Nummern bleiben, wie sie sind.",
  options: INVENTORY_NO_FORMATS.map((f) => ({ value: f, label: INVENTORY_NO_FORMAT_LABELS[f] })),
  default: "prefix-4",
});

/** INV-02: Vorgabe für den Etikettendruck (Bogen oder Endlosrolle). */
export const LABEL_FORMAT_DEFAULT = defineSetting({
  key: "gebaeude.label_format",
  label: "Etikettenformat (Vorgabe)",
  help: "Voreingestelltes Format beim Drucken von Inventar-Etiketten; im Druck jederzeit umschaltbar.",
  options: (Object.keys(LABEL_FORMATS) as (keyof typeof LABEL_FORMATS)[]).map((f) => ({ value: f, label: LABEL_FORMATS[f].label })),
  default: "bogen-3x8",
});

const weeks = (d: number) => (d % 7 === 0 ? (d === 7 ? "1 Woche" : `${d / 7} Wochen`) : `${d} Tage`);

/** INV-05: Vorgabe der Leihfrist beim Ausleihen (im Formular änderbar; fällt sie auf Wochenende/Ferien, gilt der nächste Schultag). */
export const LOAN_DAYS = defineSetting({
  key: "gebaeude.loan_days",
  label: "Leihfrist für Leihgeräte (Vorgabe)",
  help: "Vorgeschlagenes Rückgabedatum beim Ausleihen; im Formular frei änderbar (z. B. bis Schuljahresende). Fällt es auf ein Wochenende oder in die Ferien, gilt der nächste Schultag.",
  options: [7, 14, 28, 56, 91, 182].map((d) => ({ value: String(d), label: d === 91 ? "3 Monate" : d === 182 ? "6 Monate" : weeks(d) })),
  default: "28",
});

/** INV-05: Erinnerung vor dem Rückgabedatum an die entleihende Person (Benachrichtigung). */
export const LOAN_REMIND_DAYS = defineSetting({
  key: "gebaeude.loan_remind_days",
  label: "Leihgeräte: Erinnerung vor Rückgabe",
  help: "Benachrichtigung an die entleihende Person, so viele Tage vor dem Rückgabedatum. Nach Fristende erinnert SchulOS an Schultagen bis zu dreimal im Abstand von einer Woche, ab der zweiten Erinnerung auch die Eltern Minderjähriger.",
  options: [
    { value: "0", label: "aus" },
    { value: "1", label: "1 Tag vorher" },
    { value: "3", label: "3 Tage vorher" },
    { value: "7", label: "1 Woche vorher" },
  ],
  default: "3",
});

/** INV-05: Erinnerungen nach Fristende zusätzlich per Mail (Vorgabe aus, wie Bücherei-Mahnungen) – nur an bestätigte Adressen. */
export const LOAN_MAIL = defineSetting({
  key: "gebaeude.loan_mail",
  label: "Leihgeräte: überfällige auch per Mail",
  help: "Zusätzlich zur Benachrichtigung eine Mail an bestätigte Adressen (entleihende Person, ab der zweiten Erinnerung die Eltern Minderjähriger) – ohne Gerät, nur mit Link zur Anmeldung. Braucht eingerichteten Mailversand.",
  options: [
    { value: "0", label: "aus" },
    { value: "1", label: "an" },
  ],
  default: "0",
});

/** INV-06: Vorlauf für den Hinweis „Garantie läuft ab“/„Zweckbindung endet“ in „Offen für dich“ (an die Pflegenden). */
export const DEADLINE_DAYS = defineSetting({
  key: "gebaeude.deadline_days",
  label: "Inventar: Hinweis vor Garantie-/Zweckbindungsende",
  help: "So viele Tage vor dem Ende von Garantie bzw. Zweckbindung erscheint ein Hinweis unter „Offen für dich“ – für alle, die die Kategorie pflegen. Keine Benachrichtigung, keine Mail.",
  options: [
    { value: "0", label: "aus" },
    { value: "30", label: "30 Tage vorher" },
    { value: "60", label: "60 Tage vorher" },
    { value: "90", label: "90 Tage vorher" },
  ],
  default: "60",
});

export const GEBAEUDE_SETTINGS = [REPORT_KEEP, INVENTORY_NO_FORMAT, LABEL_FORMAT_DEFAULT, LOAN_DAYS, LOAN_REMIND_DAYS, LOAN_MAIL, DEADLINE_DAYS];
