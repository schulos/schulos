import { dayOptions, defineSetting } from "@/core/modules/settings";

/** DS-15: Termine nach ihrem Ende aufbewahren (LK-TERMIN) – Vorgabe 2 Jahre (Jahresplanung), höchstens 3 Jahre. */
export const EVENT_KEEP = defineSetting({
  key: "kalender.keep_days",
  label: "Termine aufbewahren",
  help: "Gerechnet ab dem Terminende (Serien ab dem letzten Termin); danach löscht der Löschlauf.",
  options: dayOptions([365, 730, 1095], 730),
  default: "730",
  permission: "verwaltung.privacy",
});

export const KALENDER_SETTINGS = [EVENT_KEEP];
