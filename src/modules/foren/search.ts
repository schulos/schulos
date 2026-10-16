import type { SearchProvider } from "@/core/search";
import { searchTopics } from "./service";

const fmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: "Europe/Berlin" });

export const forenSearch: SearchProvider = {
  moduleId: "foren",
  async search(db, { perms }, q) {
    // Volltextsuche wie bei News: Präfixe findet sie nicht, deshalb erst ab 3 Zeichen
    if (q.length < 3) return [];
    return (await searchTopics(db, perms, q)).map((t) => ({
      group: "Foren",
      id: `forum:${t.id}`,
      title: t.title,
      subtitle: `${t.forumName} · ${fmt.format(t.lastPostAt)}`,
      href: `/foren/thema/${t.id}`,
      icon: "MessagesSquare",
    }));
  },
};
