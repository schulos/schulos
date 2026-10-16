import type { SearchProvider } from "@/core/search";
import { toBerlinDate } from "@/core/time";
import { searchPlans } from "./service";

/** Sitzpläne eigener Lerngruppen nach Titel oder Gruppe (P5-03) – nur für Lehrkräfte der Gruppe und Klassenleitung. */
export const sitzplanSearch: SearchProvider = {
  moduleId: "sitzplan",
  async search(db, { perms }, q) {
    const rows = await searchPlans(db, perms, q, toBerlinDate(new Date()));
    return rows.map((p) => ({ group: "Sitzpläne", id: `sitzplan:${p.id}`, title: p.title, subtitle: p.groupName, href: `/sitzplan/${p.id}`, icon: "Armchair" }));
  },
};
