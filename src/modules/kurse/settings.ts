import { defineSetting } from "@/core/modules/settings";

/** V-01: Link auf einen externen Konferenzraum im Kursraum – die Schule schaltet externe Dienste bewusst frei. */
export const KONFERENZ_SETTING = defineSetting({
  key: "kurse.konferenz",
  label: "Konferenzlinks im Kursraum",
  help: "Leitung und Lehrkräfte einer Gruppe können einen Link auf einen externen Konferenzraum hinterlegen. Den Dienst und seinen Vertrag wählt die Schule.",
  options: [
    { value: "aus", label: "aus" },
    { value: "an", label: "an" },
  ],
  default: "aus",
});

export const KURSE_SETTINGS = [KONFERENZ_SETTING];
