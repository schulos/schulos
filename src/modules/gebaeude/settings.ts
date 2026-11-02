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

export const GEBAEUDE_SETTINGS = [REPORT_KEEP, INVENTORY_NO_FORMAT, LABEL_FORMAT_DEFAULT];
