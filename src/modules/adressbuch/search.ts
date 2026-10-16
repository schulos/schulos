import { GROUP_KIND_LABELS, ROLE_LABELS } from "@/core/labels";
import type { SearchProvider } from "@/core/search";
import { initials } from "@schulos/ui/misc";
import { searchGroups, searchPeople } from "./service";

export const adressbuchSearch: SearchProvider = {
  moduleId: "adressbuch",
  async search(db, { perms }, q) {
    const [people, groups] = await Promise.all([searchPeople(db, perms, q, 6), searchGroups(db, perms, q, 5)]);
    return [
      ...people.map((p) => ({
        group: "Personen",
        id: `person:${p.id}`,
        title: p.name,
        subtitle: p.shortCode ? `${ROLE_LABELS[p.role]} · ${p.shortCode}` : ROLE_LABELS[p.role],
        href: `/adressbuch/person/${p.id}`,
        avatar: p.shortCode ?? initials(p.name),
      })),
      ...groups.map((g) => ({
        group: "Gruppen",
        id: `group:${g.id}`,
        title: g.name,
        subtitle: GROUP_KIND_LABELS[g.kind],
        href: `/adressbuch/gruppe/${g.id}`,
        icon: "Users",
      })),
    ];
  },
};
