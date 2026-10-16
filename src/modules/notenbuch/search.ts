import type { SearchProvider } from "@/core/search";
import { ownBookLinks } from "./links";

/** Eigene Notenbücher nach Lerngruppe oder Fach (P5-16) – nur Bücher, in denen die Person als Lehrkraft steht; nie Noten. */
export const notenbuchSearch: SearchProvider = {
  moduleId: "notenbuch",
  async search(db, { perms }, q) {
    const rows = await ownBookLinks(db, perms, { q, limit: 5 });
    return rows.map((b) => ({
      group: "Notenbücher",
      id: `notenbuch:${b.id}`,
      title: `${b.groupName} – ${b.subjectName}`,
      subtitle: `${b.schoolYearName} · ${b.term}. Halbjahr${b.locked ? " · abgeschlossen" : ""}`,
      href: `/notenbuch/${b.id}`,
      icon: "NotebookPen",
    }));
  },
};
