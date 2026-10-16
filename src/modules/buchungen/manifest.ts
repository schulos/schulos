import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "buchungen",
  name: "Buchungen",
  description: "Räume und Geräte buchen",
  icon: "CalendarCheck",
  section: "organisation",
  order: 40,
  permissions: {
    "buchungen.book": "Räume und Geräte buchen",
    "buchungen.manage": "Ressourcen verwalten und fremde Buchungen stornieren",
  },
  defaultGrants: { lehrkraft: ["buchungen.book"], verwaltung: ["buchungen.book", "buchungen.manage"] },
  nav: [
    { href: "/buchungen", label: "Buchungen", roles: ["lehrkraft", "verwaltung", "admin"] },
    // Hausmeisterei: Belegung nur lesen (Q5-08b)
    { href: "/buchungen", label: "Buchungen", roles: ["personal"], requires: "gebaeude.manage", requiresModule: "gebaeude" },
  ],
  retention: [
    {
      table: "bookings",
      purpose: "Räume und Geräte reservieren",
      categories: ["Ressource", "Datum", "Stunde", "Buchende Person", "Gruppe", "Notiz"],
      class: "LK-90",
      start: "date",
      note: "zählt ab dem Buchungstag",
    },
  ],
  processing: {
    title: "Raum- und Gerätebuchung",
    purpose: "Räume und Geräte buchen und Belegungen zeigen",
    subjects: ["Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["Kollegium (Belegung mit Name der buchenden Person)", "Hausmeisterei mit „Gebäude & Technik verwalten“ (nur lesen, ohne Notiz)"],
  },
});
