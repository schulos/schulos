import { defineSetting, gradeOptions } from "@/core/modules/settings";

/** Hausaufgaben für Eltern sichtbar bis Jahrgang (Q5-14, F-04): Vorgabe aus; Schüler:innen sehen sie immer. */
export const PARENTS_HOMEWORK = defineSetting({
  key: "klassenbuch.parents_homework",
  label: "Hausaufgaben für Eltern sichtbar",
  help: "Schüler:innen sehen ihre Hausaufgaben immer; Eltern nur bis zum gewählten Jahrgang.",
  options: gradeOptions(5, 10),
  default: "0",
});

export const KLASSENBUCH_SETTINGS = [PARENTS_HOMEWORK];
