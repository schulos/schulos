import type { SearchProvider } from "@/core/search";
import { STATUS_LABELS } from "./labels";
import { canUse, placeLabel, searchTickets } from "./service";

/** Meldungen nach Nummer, Titel, Ort oder Raum – nur eigene bzw. mit „manage“/„view_all“ alle. */
export const gebaeudeSearch: SearchProvider = {
  moduleId: "gebaeude",
  async search(db, { perms }, q) {
    if (!canUse(perms)) return [];
    const rows = await searchTickets(db, perms, q);
    return rows.map((t) => ({
      group: "Meldungen",
      id: `gebaeude:${t.id}`,
      title: t.title,
      subtitle: `${t.number} · ${placeLabel(t)} · ${STATUS_LABELS[t.status]}`,
      href: `/gebaeude/${t.id}`,
      icon: "Wrench",
    }));
  },
};
