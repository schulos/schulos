import { defineModule } from "@/core/modules/types";
import { GANZTAG_SETTINGS } from "./settings";

// Ganztag – Anwesenheitslisten (Block GT, docs/GANZTAG.md). Listen gibt es nur für Gruppen der Arten AG, Förderkurs und frei mit
// eingeschaltetem Merkmal `ganztag.liste`. Die Leitung einer Gruppe (Gruppenleitung) erfasst und liest nur ihre eigenen Listen –
// im Service geprüft; „Ganztag verwalten“ darf alles. Abgleich mit den Abwesenheiten und Hinweis an die Klassenleitung (GT-04),
// Familienansicht (GT-05), Auswertung ohne Namen (GT-06, `ganztag.view_all`), Häkchen in der Kurswahl-Übernahme (GT-07).
export default defineModule({
  id: "ganztag",
  name: "Ganztag",
  description: "Anwesenheitslisten für AGs, Förderkurse und Ganztagsangebote – Termine mit Ferien, Ausfall, Erfassung per Klick",
  icon: "UserCheck",
  section: "organisation",
  order: 27,
  permissions: {
    "ganztag.manage": "Ganztag verwalten: Anwesenheitslisten für Gruppen einschalten, Termine und Listen aller Angebote",
    "ganztag.view_all": "Ganztag auswerten: „offen heute“ und Teilnahme aller Angebote je Monat ohne Namen (auch als CSV)",
  },
  defaultGrants: { verwaltung: ["ganztag.manage", "ganztag.view_all"] },
  groupFeatures: { "ganztag.liste": "Anwesenheitsliste (Ganztag)" },
  // Merkmal nur für AGs, Förderkurse und freie Gruppen; schalten nur Gruppenverwaltung bzw. „Ganztag verwalten“, nicht die Kursleitung
  groupFeatureRules: { "ganztag.liste": { kinds: ["ag", "foerderkurs", "frei"], manageOnly: true } },
  settings: GANZTAG_SETTINGS,
  nav: [
    { href: "/ganztag", label: "Ganztag", roles: ["lehrkraft", "personal", "beratung", "verwaltung", "admin"] },
    // GT-05: Familien sehen nur die eigenen Zeilen bzw. die ihres Kindes
    { href: "/ganztag", label: "Ganztag", roles: ["schueler", "eltern"] },
  ],
  retention: [
    {
      table: "ganztag_sessions",
      purpose: "Termine eines Ganztagsangebots mit Erfassung der Anwesenheit (Aufsicht und Organisation)",
      categories: ["Gruppe", "Datum und Zeit", "Status (geplant/ausgefallen/erfasst)", "erfasst von und am"],
      class: "LK-SJ",
      start: "date",
      note: "zum Ende des Schuljahres des Termins; mit dem Termin gehen alle Markierungen",
    },
    {
      table: "ganztag_marks",
      purpose: "Anwesenheit je Termin (anwesend/fehlt/verspätet) – ohne Gründe",
      categories: ["Schüler:in", "Status", "Minuten verspätet", "entschuldigt ja/nein/offen", "Herkunft", "erfasst von und am"],
      follows: "ganztag_sessions",
    },
  ],
  processing: {
    title: "Anwesenheit in Ganztags- und AG-Angeboten",
    purpose: "Aufsicht und Organisation im Ganztag: wer an einem Termin da sein müsste und wer da war; Ausfall an Teilnehmende und Eltern melden",
    // GANZTAG.md „Datenschutz“: Rechtsgrundlage und Einordnung als Schulversäumnis sind schulform- und länderabhängig
    subjects: ["Schüler:innen (Teilnehmende)", "Leitung der Angebote"],
    recipients: [
      "Leitung des Angebots (nur die eigenen Gruppen)",
      "Personen mit „Ganztag verwalten“ (alle Listen)",
      "Klassenleitung (Zeilen der Kinder ihrer Klasse; bei verpflichtenden Angeboten ein gebündelter Tageshinweis zu unentschuldigtem Fehlen)",
      "Schüler:in selbst; Eltern minderjähriger Kinder bzw. eigenständiger Schüler:innen mit Einwilligung (nur die Zeilen des eigenen Kindes, Hinweis auf einen Ausfall)",
      "Personen mit „Ganztag auswerten“ (nur Zahlen je Angebot und Monat, ohne Namen)",
    ],
    note: "Erfasst wird nur anwesend/fehlt/verspätet (Minuten) – keine Gründe, kein Freitext, kein Gesundheitsbezug. Aus den Abwesenheiten wird nur gelesen, ob eine Krankmeldung, Beurlaubung oder Entscheidung vorliegt (Vorbelegung „fehlt (entschuldigt)“, abschaltbar je Angebot) – nie der Grund. Keine Schreibverbindung ins Klassenbuch: bei verpflichtenden Angeboten nur ein Hinweis an die Klassenleitung. Listen starten leer. Rechtsgrundlage und die Frage, ob Fehlen im Ganztag als Schulversäumnis zählt: schulform- und länderabhängig, zu prüfen.",
  },
});
