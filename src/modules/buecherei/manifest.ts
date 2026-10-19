import { defineModule } from "@/core/modules/types";

// Schulbücherei (Block BU, docs/BUECHEREI.md). Bis Stufe 1 fertig ist (GATE BU1) kommt das Modul auch bei einer
// Neuinstallation ausgeschaltet; die Demo schaltet es ein. Stand BU-01: Bestand (Titel, Exemplare) ohne Personenbezug –
// Ausleihen mit Löschregeln und Verarbeitungstätigkeit folgen mit BU-02.
export default defineModule({
  id: "buecherei",
  name: "Bücherei",
  description: "Schulbücherei und Mediothek: Bestand mit Exemplarnummern, Theke, Katalog – später auch die Schulbuchausleihe",
  icon: "Library",
  section: "organisation",
  order: 55,
  defaultEnabled: false,
  permissions: {
    "buecherei.use": "Katalog durchsuchen, eigene Ausleihen sehen, vormerken und verlängern",
    "buecherei.desk": "Theke: Ausleihe und Rückgabe verbuchen (sieht nur Name, Klasse und offene Ausleihen der Person, keinen Verlauf)",
    "buecherei.stock": "Bestand pflegen: Titel und Exemplare anlegen, ändern, importieren und aussondern",
    "buecherei.materials": "Schulbuchausleihe (Lernmittel) organisieren und Ersatzforderungen erfassen",
  },
  defaultGrants: {
    schueler: ["buecherei.use"],
    lehrkraft: ["buecherei.use"],
    verwaltung: ["buecherei.use", "buecherei.desk", "buecherei.stock", "buecherei.materials"],
  },
  nav: [{ href: "/buecherei/bestand", label: "Bücherei", requires: "buecherei.stock" }],
});
