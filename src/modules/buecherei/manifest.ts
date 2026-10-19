import { defineModule } from "@/core/modules/types";
import { BUECHEREI_SETTINGS } from "./settings";

// Schulbücherei (Block BU, docs/BUECHEREI.md). Bis Stufe 1 fertig ist (GATE BU1) kommt das Modul auch bei einer
// Neuinstallation ausgeschaltet; die Demo schaltet es ein. Bestand (BU-01) ohne Personenbezug; Ausleihen (BU-02) mit
// Personenbezug nur, solange sie offen sind.
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
    "buecherei.materials": "Schulbuchausleihe (Lernmittel) organisieren, Befunde bei der Rückgabe und Ersatzforderungen bearbeiten",
  },
  defaultGrants: {
    schueler: ["buecherei.use"],
    lehrkraft: ["buecherei.use"],
    verwaltung: ["buecherei.use", "buecherei.desk", "buecherei.stock", "buecherei.materials"],
  },
  // BU-02: Leihfrist je Medienart, Verlängerungen
  settings: BUECHEREI_SETTINGS,
  nav: [{ href: "/buecherei", label: "Bücherei", requires: ["buecherei.desk", "buecherei.stock"] }],
  retention: [
    {
      table: "buecherei_loans",
      scope: "offene Ausleihen",
      purpose: "Ausleihe von Medien der Schulbücherei (wer hat welches Exemplar bis wann)",
      categories: ["Person (Konto)", "Exemplar", "Ausleihdatum", "Fälligkeit", "Zahl der Verlängerungen"],
      class: "LK-KONTO",
      start: "user_id",
      where: "returned_on is null",
      note: "Rückgabe ohne Befund löscht die Ausleihe sofort (nur ein Zähler je Monat und Medienart bleibt, ohne Person); Kontolöschung entfernt die Person, das Exemplar bleibt als ausgeliehen sichtbar",
    },
    {
      table: "buecherei_loans",
      scope: "Rückgaben mit Befund",
      purpose: "Schaden oder Unvollständigkeit bei der Rückgabe klären (Grundlage einer Ersatzforderung)",
      categories: ["Person (Konto)", "Exemplar", "Rückgabedatum", "Befund (Sache, ohne Namen)", "erledigt am"],
      class: "LK-SJ-1J",
      start: "finding_resolved_on",
      where: "returned_on is not null and finding_resolved_on is not null",
      note: "bleibt bis zur Erledigung, danach bis Schuljahresende + 1 Jahr",
    },
    {
      table: "buecherei_cards",
      purpose: "Büchereiausweis: pseudonymer Code, mit dem die Theke die Person wählt",
      categories: ["Konto", "zufälliger Ausweis-Code (ohne Namen oder Kontonummer)", "angelegt am"],
      class: "LK-KONTO",
      start: "user_id",
      note: "Ersatz bei Verlust löscht den alten Code; geht mit dem Konto",
    },
  ],
  processing: {
    title: "Schulbücherei: Ausleihe",
    purpose: "Medien der Schulbücherei ausleihen und zurücknehmen, Fristen und Schäden nachhalten",
    subjects: ["Schüler:innen", "Lehrkräfte", "weiteres Personal"],
    recipients: [
      "Büchereiteam an der Theke (Recht „Theke“, auch Schüler-Helfer:innen): nur Name, Klasse und offene Ausleihen der Person",
      "Verwaltung mit „Schulbuchausleihe“: Rückgaben mit Befund",
    ],
    note: "Kein Ausleihverlauf je Person: Die Rückgabe ohne Befund löscht die Ausleihe sofort, es bleiben nur Zähler je Monat und Medienart ohne Personenbezug. Ausleihe und Rückgabe stehen nicht im Audit-Log, nur Befunde. Büchereiausweise tragen Name, Klasse und einen zufälligen Code ohne Namen oder Kontonummer; Ersatz macht den alten Code ungültig. Keine Leseempfehlungen oder Auswertungen aus dem Ausleihverhalten.",
  },
});
