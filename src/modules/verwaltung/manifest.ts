import { defineModule } from "@/core/modules/types";
import { VERWALTUNG_SETTINGS } from "./settings";

export default defineModule({
  id: "verwaltung",
  name: "Verwaltung",
  description: "Benutzer, Gruppen, Rechte, Module und Stammdaten",
  icon: "ShieldCheck",
  section: "verwaltung",
  core: true,
  permissions: {
    "verwaltung.access": "Verwaltungsbereich öffnen",
    "verwaltung.users": "Benutzer verwalten",
    "verwaltung.zwei_faktor": "Zwei-Faktor-Anmeldung zurücksetzen, Einrichtung von außen freigeben, Code-Listen drucken",
    "verwaltung.groups": "Gruppen verwalten",
    "verwaltung.rights": "Rechte und Module verwalten",
    "verwaltung.privacy": "Löschlauf ausführen und Löschsperren setzen (Datenschutz)",
    "verwaltung.school": "Schuldaten und Stammdaten pflegen",
    "verwaltung.system": "Systembetrieb: Backupserver koppeln (später Updates)",
  },
  defaultGrants: { verwaltung: ["verwaltung.access", "verwaltung.users", "verwaltung.groups", "verwaltung.school", "verwaltung.zwei_faktor"] },
  nav: [{ href: "/verwaltung", label: "Verwaltung", requires: "verwaltung.access" }],
  settings: VERWALTUNG_SETTINGS,
});
