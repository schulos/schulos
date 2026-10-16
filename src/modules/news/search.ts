import type { SearchProvider } from "@/core/search";
import { listPosts } from "./service";

const fmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: "Europe/Berlin" });

export const newsSearch: SearchProvider = {
  moduleId: "news",
  async search(db, { perms }, q) {
    // websearch_to_tsquery ist robust gegen beliebige Eingaben; Präfixe findet die Volltextsuche nicht,
    // deshalb erst ab 3 Zeichen.
    if (q.length < 3) return [];
    const posts = await listPosts(db, perms, { q, limit: 5 });
    return posts.map((p) => ({
      group: "News",
      id: `news:${p.id}`,
      title: p.title,
      subtitle: `${p.authorName ?? "Unbekannt"} · ${fmt.format(p.publishedAt)}`,
      href: `/news/${p.id}`,
      icon: "Megaphone",
    }));
  },
};
