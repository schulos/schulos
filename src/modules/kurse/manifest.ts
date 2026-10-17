import { defineModule } from "@/core/modules/types";
import { KURSE_SETTINGS } from "./settings";

export default defineModule({
  id: "kurse",
  name: "Kursraum",
  description: "Je Gruppe ein Raum mit Stunden, Aufgaben, Terminen, Dateien, Chat und Mitgliedern",
  icon: "GraduationCap",
  section: "unterricht",
  order: 5,
  permissions: {
    "kurse.view": "Kursräume der eigenen Gruppen öffnen",
    "kurse.view_all": "Kursräume aller Gruppen öffnen (ohne Mitgliedschaft)",
  },
  defaultGrants: { schueler: ["kurse.view"], lehrkraft: ["kurse.view"], verwaltung: ["kurse.view", "kurse.view_all"] },
  nav: [{ href: "/kurse", label: "Meine Kurse", requires: "kurse.view" }],
  settings: KURSE_SETTINGS,
  // sonst keine eigenen Tabellen: der Kursraum zeigt, was die anderen Module schon speichern
  retention: [
    {
      table: "kurse_links",
      purpose: "Link auf einen externen Konferenzraum der Gruppe (V-01)",
      categories: ["Gruppe", "Adresse und Bezeichnung des Raums", "zuletzt geändert von/am"],
      follows: "groups",
    },
  ],
  processing: {
    title: "Kursraum",
    purpose: "Inhalte einer Lerngruppe (Stunden, Aufgaben, Termine, Dateien, Chat, Mitglieder) an einer Stelle anzeigen",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: ["Mitglieder der Gruppe", "Verwaltung"],
    note: "Speichert selbst nur den optionalen Konferenzlink (Moduleinstellung, Vorgabe aus); Gruppenordner, Termine und Chat sieht nur, wer Mitglied der Gruppe ist. Den Konferenzdienst wählt die Schule – SchulOS ruft ihn nie selbst auf, der Link öffnet ihn im Browser der Person.",
  },
});
