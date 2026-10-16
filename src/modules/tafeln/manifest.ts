import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "tafeln",
  name: "Tafeln",
  description: "Digitale Tafeln zum gemeinsamen Zeichnen und Skizzieren – gespeichert im Gruppenordner",
  icon: "PenTool",
  section: "unterricht",
  order: 46,
  nav: [{ href: "/tafeln", label: "Tafeln" }],
  // Keine eigene Tabelle: eine Tafel ist eine Datei „*.excalidraw“ im Gruppenordner (file_nodes, Modul Dateien) und folgt
  // dessen Löschregel (mit der Gruppe bzw. beim Löschen der Datei).
  processing: {
    title: "Tafeln",
    purpose: "In Lerngruppen und Teams gemeinsam zeichnen und skizzieren",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: ["Mitglieder der Gruppe"],
    note: "Gespeichert als Datei im Gruppenordner; wer welches Element gezeichnet hat, wird nicht gespeichert.",
  },
});
