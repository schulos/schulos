import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "pinnwaende",
  name: "Pinnwände",
  description: "Pinnwände mit Spalten und Karten – je Gruppe oder frei mit Mitgliedern, live für alle",
  icon: "StickyNote",
  section: "unterricht",
  order: 40,
  permissions: { "pinnwaende.create": "Freie Pinnwände mit eigenen Mitgliedern anlegen" },
  defaultGrants: { lehrkraft: ["pinnwaende.create"], verwaltung: ["pinnwaende.create"] },
  groupFeatures: { "pinnwaende.board": "Pinnwände" },
  nav: [{ href: "/pinnwaende", label: "Pinnwände" }],
  retention: [
    {
      table: "pinnwaende_boards",
      purpose: "Ideen, Material und Ergebnisse gemeinsam sammeln",
      categories: ["Titel", "Ersteller:in", "Zeitpunkt"],
      class: "LK-ENDE-1J",
      start: "updated_at",
      note: "Ein Jahr nach der letzten Änderung; Pinnwände einer Gruppe auch mit der Gruppe.",
    },
    { table: "pinnwaende_members", purpose: "Mitglieder freier Pinnwände", categories: ["Mitglied", "Leitung ja/nein"], follows: "pinnwaende_boards" },
    { table: "pinnwaende_cards", purpose: "Karten einer Pinnwand", categories: ["Text", "Link", "Datei-Verweis", "Verfasser:in", "Zeitpunkt"], follows: "pinnwaende_boards" },
  ],
  processing: {
    title: "Pinnwände",
    purpose: "Ideen, Material und Ergebnisse in Lerngruppen und Projektteams sammeln",
    subjects: ["Schüler:innen", "Lehrkräfte"],
    recipients: ["Mitglieder der Gruppe bzw. der Pinnwand"],
  },
});
