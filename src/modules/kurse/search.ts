import type { SearchProvider } from "@/core/search";
import { myCourses, searchCourses } from "./service";

/** Eigene Kurse nach Name; mit `kurse.view_all` auch alle anderen Gruppen. */
export const kurseSearch: SearchProvider = {
  moduleId: "kurse",
  async search(db, { perms }, q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (name: string) => terms.every((t) => name.toLowerCase().includes(t));
    const own = (await myCourses(db, perms)).filter((c) => match(c.name));
    const others = (await searchCourses(db, perms, q)).filter((g) => !own.some((c) => c.id === g.id));
    return [
      ...own.map((c) => ({ id: c.id, name: c.name, subtitle: `${c.kindLabel}${c.leader ? " · Leitung" : ""} · ${c.members} Mitglieder` })),
      ...others.map((g) => ({ id: g.id, name: g.name, subtitle: `${g.members} Mitglieder` })),
    ]
      .slice(0, 5)
      .map((c) => ({ group: "Kurse", id: `kurs:${c.id}`, title: c.name, subtitle: c.subtitle, href: `/kurse/${c.id}`, icon: "GraduationCap" }));
  },
};
