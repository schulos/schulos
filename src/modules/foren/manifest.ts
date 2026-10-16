import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "foren",
  name: "Foren",
  description: "Forum je Gruppe und ein Forum fürs Kollegium – Themen, Antworten, Abo",
  icon: "MessagesSquare",
  section: "kommunikation",
  order: 25,
  permissions: { "foren.moderate": "Alle Foren moderieren (Beiträge ausblenden, Themen sperren, Meldungen bearbeiten)" },
  defaultGrants: { verwaltung: ["foren.moderate"] },
  groupFeatures: { "foren.forum": "Forum" },
  nav: [{ href: "/foren", label: "Foren" }],
  retention: [
    {
      table: "foren_topics",
      purpose: "Austausch in Gruppen und im Kollegium",
      categories: ["Titel", "Verfasser:in", "Zeitpunkt"],
      class: "LK-ENDE-1J",
      start: "last_post_at",
      note: "Ein Jahr nach der letzten Antwort; mit der Gruppe gelöscht.",
    },
    {
      table: "foren_posts",
      purpose: "Beiträge in Foren",
      categories: ["Beitragstext", "Verfasser:in", "Zeitpunkt", "Moderation (ausgeblendet von, Grund)"],
      follows: "foren_topics",
    },
    {
      table: "foren_reports",
      purpose: "Gemeldete Beiträge prüfen",
      categories: ["Meldende:r", "Grund", "Zeitpunkt", "Bearbeitet von"],
      class: "LK-90",
      start: "created_at",
      note: "Ausgeblendete Beiträge bleiben bis zur Löschfrist des Themas als Nachweis gespeichert; Meldungen 90 Tage.",
    },
    { table: "foren_subscriptions", purpose: "Benachrichtigung bei neuen Antworten", categories: ["Abonnent:in"], follows: "foren_topics" },
  ],
  processing: {
    title: "Foren",
    purpose: "Austausch innerhalb von Lerngruppen, AGs und im Kollegium",
    subjects: ["Schüler:innen", "Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["Mitglieder der Gruppe bzw. das Kollegium"],
  },
});
