import type { SearchProvider } from "@/core/search";
import { searchPages } from "./service";

/** HB-03: Suchanbieter „Handbuch“ für die globale Suche (Strg+K) – nur Seiten, die die Person sehen darf. */
export const hilfeSearch: SearchProvider = {
  moduleId: "hilfe",
  async search(db, { perms }, q) {
    const pages = await searchPages(db, perms, q, 5);
    return pages.map((p) => ({
      group: "Handbuch",
      id: `hilfe:${p.id}`,
      title: p.title,
      subtitle: p.status === "entwurf" ? `${p.sectionTitle} · Entwurf` : p.sectionTitle,
      href: `/hilfe/${p.slug}`,
      icon: "LifeBuoy",
    }));
  },
};
