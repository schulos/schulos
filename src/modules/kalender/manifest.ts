import { defineModule } from "@/core/modules/types";
import { KALENDER_SETTINGS } from "./settings";

export default defineModule({
  id: "kalender",
  name: "Kalender",
  description: "Persönliche Termine, Gruppen- und Schulkalender",
  icon: "CalendarDays",
  section: "organisation",
  mobile: 5,
  order: 30,
  permissions: {
    "kalender.school": "Termine im Schulkalender eintragen",
    "kalender.manage": "Alle Kalender bearbeiten",
  },
  defaultGrants: { verwaltung: ["kalender.school"] },
  groupFeatures: { "kalender.gruppenkalender": "Gruppenkalender" },
  nav: [{ href: "/kalender", label: "Kalender" }],
  settings: KALENDER_SETTINGS,
  retention: [
    {
      table: "calendar_events",
      purpose: "Termine planen",
      categories: ["Titel", "Beschreibung", "Ort", "Zeitraum", "Eigentümer:in"],
      class: "LK-TERMIN",
      start: "repeat_weekly_until",
      fallback: "ends_at",
      period: "kalender.keep_days",
      note: "Serien zählen ab ihrem letzten Termin",
    },
    {
      table: "calendar_feed_tokens",
      purpose: "Kalender-Abo: eigener Kalender in der Kalender-App (nur lesend, per widerrufbarem Link)",
      categories: ["Konto", "Kalender", "Bezeichnung des Links", "Link (nur als Hash)", "zuletzt genutzt (stundengenau)"],
      class: "LK-1J",
      start: "last_used_at",
      fallback: "created_at",
      note: "unbenutzte Links verfallen nach einem Jahr; Widerruf und Kontolöschung löschen sofort",
    },
  ],
  processing: {
    title: "Kalender",
    purpose: "Persönliche, Gruppen- und Schultermine planen",
    subjects: ["Schüler:innen", "Eltern", "Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["Mitglieder der Gruppe bzw. Schulgemeinschaft (je nach Kalender)", "nur die Person selbst (persönliche Termine)"],
    note: "Kalender-Abo (Q5-15): Wer einen Abo-Link anlegt, gibt die Termine dieses Kalenders an die eigene Kalender-App bzw. deren Anbieter weiter (Entscheidung der Person); der Link ist widerrufbar und von außen nur nutzbar, wenn die Schule Außenzugang erlaubt.",
  },
});
