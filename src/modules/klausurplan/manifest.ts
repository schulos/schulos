import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "klausurplan",
  name: "Klausurplan",
  description: "Klassenarbeiten und Klausuren mit Regelprüfung",
  icon: "FileCheck",
  section: "organisation",
  order: 30,
  permissions: {
    "klausurplan.plan": "Klassenarbeiten für eigene Gruppen eintragen",
    "klausurplan.manage": "Alle Klassenarbeiten bearbeiten, Ausnahmen genehmigen",
  },
  defaultGrants: { lehrkraft: ["klausurplan.plan"], verwaltung: ["klausurplan.plan", "klausurplan.manage"] },
  nav: [{ href: "/klausurplan", label: "Klausurplan" }],
  retention: [
    {
      table: "exams",
      purpose: "Klassenarbeiten und Klausuren planen",
      categories: ["Gruppe", "Fach", "Datum", "Stunden", "Lehrkraft"],
      class: "LK-SJ-1J",
      start: "date",
    },
  ],
  processing: {
    title: "Klausurplan",
    purpose: "Klassenarbeiten und Klausuren planen und Regelverstöße erkennen",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: ["Lerngruppe", "Lehrkräfte", "Schulleitung"],
  },
});
