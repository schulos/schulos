import { canCreate, listForStudent, listForTeacher, STATUS_LABELS } from "./service";
import type { SearchProvider } from "@/core/search";

const fmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", timeZone: "Europe/Berlin" });

export const aufgabenSearch: SearchProvider = {
  moduleId: "aufgaben",
  async search(db, { perms }, q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (title: string) => terms.every((t) => title.toLowerCase().includes(t));
    if (canCreate(perms)) {
      return (await listForTeacher(db, perms))
        .filter((t) => match(t.title))
        .slice(0, 5)
        .map((t) => ({ group: "Aufgaben", id: `task:${t.id}`, title: t.title, subtitle: `${t.groups.join(", ")} · ${t.submitted}/${t.students} abgegeben`, href: `/aufgaben/${t.id}`, icon: "ClipboardCheck" }));
    }
    return (await listForStudent(db, perms))
      .filter((t) => match(t.title))
      .slice(0, 5)
      .map((t) => ({ group: "Aufgaben", id: `task:${t.id}`, title: t.title, subtitle: `bis ${fmt.format(t.dueAt)} · ${STATUS_LABELS[t.status]}`, href: `/aufgaben/${t.id}`, icon: "ClipboardCheck" }));
  },
};
