import { defineSetting } from "@/core/modules/settings";

/** F5-09: Profilbilder im Sitzplan – nur von Personen mit Einwilligung (DS-09); gedruckt wird immer ohne Fotos. */
export const PHOTOS_SETTING = defineSetting({
  key: "sitzplan.photos",
  label: "Profilbilder im Sitzplan",
  help: "Zeigt am Platz das Profilbild – nur von Personen mit Einwilligung, sonst die Initialen. Der Druck enthält nie Fotos.",
  options: [
    { value: "an", label: "an (nur mit Einwilligung)" },
    { value: "aus", label: "aus – nur Initialen" },
  ],
  default: "an",
});

export const SITZPLAN_SETTINGS = [PHOTOS_SETTING];
