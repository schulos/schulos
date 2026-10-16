import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "aufgaben",
  name: "Aufgaben",
  description: "Aufgaben stellen, abgeben, Feedback geben",
  icon: "ClipboardCheck",
  section: "unterricht",
  mobile: 3,
  order: 10,
  permissions: {
    "aufgaben.create": "Aufgaben stellen",
    "aufgaben.view_all": "Alle Aufgaben einsehen",
  },
  defaultGrants: { lehrkraft: ["aufgaben.create"] },
  nav: [{ href: "/aufgaben", label: "Aufgaben", roles: ["schueler", "lehrkraft", "verwaltung", "admin"] }],
  retention: [
    {
      table: "tasks",
      purpose: "Aufgaben stellen und Leistungen nachvollziehen",
      categories: ["Aufgabentext", "Lehrkraft", "Fristen"],
      class: "LK-SJ-1J",
      start: "created_at",
    },
    { table: "task_groups", purpose: "Zielgruppen einer Aufgabe", categories: ["Gruppe"], follows: "tasks" },
    {
      table: "task_submissions",
      purpose: "Abgaben und Rückmeldung",
      categories: ["Abgabetext", "Schüler:in", "Abgabezeitpunkt", "Feedback", "Bewertung"],
      follows: "tasks",
    },
    { table: "task_files", purpose: "Material und Abgabedateien", categories: ["Dateiinhalt", "Dateiname", "Hochgeladen von"], follows: "tasks" },
  ],
  processing: {
    title: "Aufgaben",
    purpose: "Aufgaben stellen, Abgaben sammeln und Rückmeldung geben",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: ["Lehrkräfte der Lerngruppe", "die Schülerin bzw. der Schüler selbst (eigene Abgabe und Rückmeldung)"],
  },
});
