import { defineModule } from "@/core/modules/types";

export default defineModule({
  id: "news",
  name: "News",
  description: "Schwarzes Brett mit Zielgruppen und angehefteten Beiträgen",
  icon: "Megaphone",
  section: "kommunikation",
  order: 20,
  permissions: {
    "news.write": "Beiträge schreiben",
    "news.manage": "Alle Beiträge bearbeiten und anheften",
  },
  defaultGrants: { lehrkraft: ["news.write"], verwaltung: ["news.write", "news.manage"] },
  nav: [{ href: "/news", label: "News" }],
  retention: [
    {
      table: "news_posts",
      purpose: "Informationen der Schule an Zielgruppen",
      categories: ["Beitragstext", "Verfasser:in", "Zeitpunkt"],
      class: "LK-ENDE-1J",
      start: "expires_at",
      fallback: "published_at",
    },
    { table: "news_targets", purpose: "Zielgruppen eines Beitrags", categories: ["Zielgruppe"], follows: "news_posts" },
  ],
  processing: {
    title: "News",
    purpose: "Informationen der Schule an festgelegte Zielgruppen",
    subjects: ["Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["Zielgruppen des Beitrags", "Statusmonitore, wenn ein Beitrag dafür markiert ist"],
  },
});
