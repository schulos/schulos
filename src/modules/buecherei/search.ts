import type { SearchProvider } from "@/core/search";
import { canUse, searchCatalog } from "./katalog";
import { MEDIA_TYPE_LABELS } from "./labels";

/** BU-03: Katalogtreffer in der globalen Suche (Recht `buecherei.use`) – nur Titel und Verfügbarkeit, keine Personen. */
export const buechereiSearch: SearchProvider = {
  moduleId: "buecherei",
  async search(db, { perms }, q) {
    if (!canUse(perms)) return [];
    return (await searchCatalog(db, perms, { q, limit: 8 })).map((t) => ({
      group: "Bücherei",
      id: `buecherei:${t.id}`,
      title: t.title,
      subtitle: [t.author, MEDIA_TYPE_LABELS[t.mediaType], t.shelf > 0 ? `${t.shelf} verfügbar` : "ausgeliehen"].filter(Boolean).join(" · "),
      href: `/buecherei/katalog/${t.id}`,
      icon: "Library",
    }));
  },
};
