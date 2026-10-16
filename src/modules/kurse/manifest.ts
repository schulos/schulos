import { defineModule } from "@/core/modules/types";

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
  // keine eigenen Tabellen: der Kursraum zeigt nur, was die anderen Module schon speichern
  processing: {
    title: "Kursraum",
    purpose: "Inhalte einer Lerngruppe (Stunden, Aufgaben, Termine, Dateien, Chat, Mitglieder) an einer Stelle anzeigen",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: ["Mitglieder der Gruppe", "Verwaltung"],
    note: "Speichert selbst nichts; Gruppenordner, Termine und Chat sieht nur, wer Mitglied der Gruppe ist.",
  },
});
