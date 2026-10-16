import { defineSetting, gradeOptions } from "@/core/modules/settings";

/** Eltern über Vertretungen/Entfall informieren bis Jahrgang (Q5-14, F-02): Vorgabe ganze Sek I, Oberstufe nie. */
export const PARENTS_SUBSTITUTION = defineSetting({
  key: "stundenplan.parents_substitution",
  label: "Eltern über Vertretungen und Entfall informieren",
  help: "Eltern minderjähriger Schüler:innen bekommen eine gebündelte Nachricht je Tag; die Oberstufe ist nie dabei.",
  options: gradeOptions(5, 10),
  default: "10",
});

/**
 * Vertretungsplan veröffentlichen (Q5-11, F-06): „sofort“ (Vorgabe, wie bisher) oder „erst nach Freigabe“ – dann ist ein
 * neuer Tag ein Entwurf, bis die Planung ihn veröffentlicht. Die Demo-Schule steht auf „Freigabe“.
 */
export const SUBSTITUTION_RELEASE = defineSetting({
  key: "stundenplan.substitution_release",
  label: "Vertretungsplan veröffentlichen",
  help: "„Erst nach Freigabe“: Änderungen eines neuen Tages sind ein Entwurf, bis die Planung den Tag veröffentlicht – dann geht je Person eine Nachricht raus. Spätere Änderungen an einem veröffentlichten Tag gelten sofort.",
  options: [
    { value: "sofort", label: "sofort" },
    { value: "freigabe", label: "erst nach Freigabe" },
  ],
  default: "sofort",
});

export const STUNDENPLAN_SETTINGS = [PARENTS_SUBSTITUTION, SUBSTITUTION_RELEASE];
