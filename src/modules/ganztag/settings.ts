import { defineSetting } from "@/core/modules/settings";

/**
 * GT-03 (Projektleitung 2026-10-28): Wie viele Tage nach dem Termin die Leitung die Liste noch erfassen oder ändern darf.
 * Wer „Ganztag verwalten“ hat, darf auch später nachtragen (Erfassung nach Papierliste).
 */
export const EDIT_DAYS = defineSetting({
  key: "ganztag.edit_days",
  label: "Nachträgliche Erfassung durch die Leitung",
  help: "So viele Tage nach dem Termin darf die Leitung die Anwesenheitsliste noch erfassen oder ändern. Danach nur noch mit „Ganztag verwalten“.",
  options: [
    { value: "0", label: "nur am Tag selbst" },
    { value: "3", label: "bis 3 Tage danach" },
    { value: "7", label: "bis 7 Tage danach" },
    { value: "14", label: "bis 14 Tage danach" },
    { value: "30", label: "bis 30 Tage danach" },
  ],
  default: "7",
});

/** GT-09 (Projektleitung 2026-11-03): Bis wann Eltern den Heimweg für den Tag selbst noch ändern dürfen (Vorgabe 12:00). */
export const WAY_HOME_DEADLINE = defineSetting({
  key: "ganztag.way_home_deadline",
  label: "Heimweg ändern durch die Familie",
  help: "Bis zu dieser Uhrzeit dürfen Eltern (bzw. eigenständige Schüler:innen) den Heimweg für denselben Tag noch ändern. Die Leitung bekommt dazu einen Gong. Für spätere Tage geht es jederzeit vorher.",
  options: [
    { value: "10", label: "bis 10:00 Uhr desselben Tages" },
    { value: "11", label: "bis 11:00 Uhr desselben Tages" },
    { value: "12", label: "bis 12:00 Uhr desselben Tages" },
    { value: "13", label: "bis 13:00 Uhr desselben Tages" },
    { value: "14", label: "bis 14:00 Uhr desselben Tages" },
  ],
  default: "12",
});

export const GANZTAG_SETTINGS = [EDIT_DAYS, WAY_HOME_DEADLINE];
