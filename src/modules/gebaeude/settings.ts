import { defineSetting } from "@/core/modules/settings";

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

export const GEBAEUDE_SETTINGS = [REPORT_KEEP];
