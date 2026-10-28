import { defineSetting } from "@/core/modules/settings";

/**
 * HB-04 (Projektleitung 2026-10-28): Erinnerung zur Überprüfung – so viele Monate nach dem letzten Prüfen bekommt die
 * Ansprechperson einer veröffentlichten Seite einmal einen Gong. „aus“ schaltet die Erinnerung ab.
 */
export const REVIEW_MONTHS = defineSetting({
  key: "hilfe.review_months",
  label: "Erinnerung zur Überprüfung",
  help: "Die Ansprechperson einer Handbuchseite bekommt nach dieser Zeit ohne Änderung einmal einen Gong „Überprüfung fällig“.",
  options: [
    { value: "0", label: "aus" },
    { value: "6", label: "nach 6 Monaten" },
    { value: "12", label: "nach 12 Monaten" },
    { value: "24", label: "nach 24 Monaten" },
  ],
  default: "12",
});

export const HILFE_SETTINGS = [REVIEW_MONTHS];
