import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "texte",
  name: "Texte",
  description: "Texte gemeinsam schreiben – je Gruppe, gleichzeitig und live für alle Mitglieder",
  icon: "FileText",
  section: "unterricht",
  order: 45,
  groupFeatures: { "texte.doc": "Texte" },
  nav: [{ href: "/texte", label: "Texte" }],
  retention: [
    {
      table: "texte_docs",
      purpose: "Texte gemeinsam schreiben (Protokolle, Gruppenarbeiten, Entwürfe)",
      categories: ["Titel", "Textinhalt", "Ersteller:in", "Zeitpunkt"],
      class: "LK-ENDE-1J",
      start: "updated_at",
      note: "Ein Jahr nach der letzten Änderung; Texte einer Gruppe auch mit der Gruppe. Wer was geschrieben hat, wird nicht gespeichert.",
    },
  ],
  processing: {
    title: "Texte",
    purpose: "Texte in Lerngruppen und Teams gemeinsam schreiben",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: ["Mitglieder der Gruppe"],
    note: "Der Text ist ein gemeinsames Dokument ohne Zuordnung einzelner Änderungen zu Personen.",
  },
});
