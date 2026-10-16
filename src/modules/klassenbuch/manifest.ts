import { defineModule } from "@/core/modules/types";
import { KLASSENBUCH_SETTINGS } from "./settings";

export default defineModule({
  id: "klassenbuch",
  name: "Klassenbuch",
  description: "Stundeninhalte, Hausaufgaben und Fehlzeiten",
  icon: "NotebookTabs",
  section: "organisation",
  order: 20,
  permissions: {
    "klassenbuch.view_all": "Alle Klassenbücher einsehen",
    "klassenbuch.manage": "Alle Einträge bearbeiten",
  },
  nav: [{ href: "/klassenbuch", label: "Klassenbuch", roles: ["lehrkraft", "verwaltung", "admin"] }],
  settings: KLASSENBUCH_SETTINGS,
  retention: [
    {
      table: "classbook_entries",
      purpose: "Klassenbuch führen (Unterrichtsinhalte, Hausaufgaben)",
      categories: ["Thema", "Hausaufgabe", "Lehrkraft", "Datum", "Stunde"],
      class: "LK-AKTE",
      start: "date",
      note: "Akte: 10 Jahre im Archivexport (§ 9 VO-DV I), im Live-System bis Schuljahresende + 1 Jahr",
    },
    {
      table: "classbook_absences",
      purpose: "Fehlzeiten und Verspätungen erfassen",
      categories: ["Schüler:in", "fehlt/verspätet", "Minuten", "entschuldigt ja/nein"],
      follows: "classbook_entries",
    },
  ],
  processing: {
    title: "Klassenbuch",
    purpose: "Klassenbuch führen: Unterrichtsinhalte, Hausaufgaben, Fehlzeiten und Verspätungen",
    // DS-17: Klassenbuch ist in der VO-DV I ausdrücklich genannt (Anlage 2 I Nr. 1: „Vermerk über Schulversäumnisse, Verspätungen“)
    legalBasis:
      "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1 und 5, § 122 Abs. 1 Satz 2 SchulG NRW sowie VO-DV I Anlage 2 I Nr. 1 (Klassenbuch: Vermerk über Schulversäumnisse, Verspätungen) und Anlage 1 Abschn. A Nr. II Ziff. 19.1 (Schulversäumnis)",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: [
      "Lehrkräfte der Klasse bzw. des Kurses",
      "Klassenleitung",
      "Schulleitung",
      "Schüler:innen der Gruppe (nur Hausaufgaben)",
      "Eltern (nur Hausaufgaben, nach Moduleinstellung bis Jahrgang)",
    ],
    note: "Schulakte: zehn Jahre Aufbewahrung im Archivexport (§ 9 VO-DV I), im Live-System nur bis Schuljahresende + 1 Jahr. Hausaufgaben sehen Schüler:innen auf Heute und im Kursraum (ohne Fehlzeiten, ohne Thema); Eltern nur, wenn die Schule es für den Jahrgang einschaltet (Vorgabe aus).",
  },
});
