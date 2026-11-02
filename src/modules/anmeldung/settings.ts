import { defineSetting } from "@/core/modules/settings";
import { CLASS_SIZE_DEFAULT } from "./klassenbildung";

/**
 * KB-02: Richtwert für die Klassengröße beim Vorschlag im Schritt „Neuaufnahmen“ (Anzahl neuer Klassen = Kinder ÷ Richtwert,
 * aufgerundet). Bandbreite 24–30, Vorgabe 27 (Klassenfrequenzrichtwert NRW Sek I). Die Gewichtung des Vorschlags bleibt fest im Code.
 */
export const KLASSENGROESSE = defineSetting({
  key: "anmeldung.klassengroesse",
  label: "Klassenbildung: Richtwert Klassengröße",
  help: "Der Vorschlag im Schritt „Neuaufnahmen“ des Schuljahreswechsels legt so viele Klassen an, dass keine mehr Kinder als der Richtwert hat, und verteilt die Kinder gleichmäßig (höchstens 1 Kind Unterschied).",
  options: [24, 25, 26, 27, 28, 29, 30].map((n) => ({
    value: String(n),
    label: `${n} Kinder${n === CLASS_SIZE_DEFAULT ? " (Vorgabe)" : ""}`,
  })),
  default: String(CLASS_SIZE_DEFAULT),
});

export const ANMELDUNG_SETTINGS = [KLASSENGROESSE];
