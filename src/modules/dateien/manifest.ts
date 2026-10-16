import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "dateien",
  name: "Dateien",
  description: "Eigene Dateien und Gruppenordner",
  icon: "Folder",
  section: "unterricht",
  order: 30,
  groupFeatures: { "dateien.gruppenordner": "Gruppenordner" },
  nav: [{ href: "/dateien", label: "Dateien" }],
  retention: [
    {
      table: "file_nodes",
      scope: "persönlicher Bereich",
      purpose: "Eigene Dateien ablegen",
      categories: ["Dateiinhalt", "Dateiname", "Größe", "Zeitpunkt"],
      class: "LK-KONTO",
      start: "owner_id",
    },
    {
      table: "file_nodes",
      scope: "Gruppenordner",
      purpose: "Material in Gruppen teilen",
      categories: ["Dateiinhalt", "Dateiname", "Hochgeladen von", "Zeitpunkt"],
      follows: "groups",
    },
  ],
  processing: {
    title: "Dateiablage",
    purpose: "Eigene Dateien ablegen und in Gruppenordnern teilen",
    subjects: ["Schüler:innen", "Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["nur die Person selbst (eigene Dateien)", "Mitglieder der Gruppe (Gruppenordner)"],
  },
});
