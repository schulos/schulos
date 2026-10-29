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

export const GANZTAG_SETTINGS = [EDIT_DAYS];
