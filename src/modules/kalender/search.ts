import type { SearchProvider } from "@/core/search";
import { addDays, toBerlinDate } from "@/core/time";
import { fmtDayShort, timeRange } from "./format";
import { listOccurrences } from "./service";

/** Kommende Termine (90 Tage) nach Titel/Ort – je Termin nur das nächste Vorkommen. */
export const kalenderSearch: SearchProvider = {
  moduleId: "kalender",
  async search(db, { perms }, q) {
    const today = toBerlinDate(new Date());
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    return (await listOccurrences(db, perms, today, addDays(today, 90)))
      .filter((o) => terms.every((t) => `${o.title} ${o.location ?? ""}`.toLowerCase().includes(t)))
      .filter((o) => !seen.has(o.eventId) && seen.add(o.eventId))
      .slice(0, 5)
      .map((o) => ({
        group: "Termine",
        id: `event:${o.eventId}`,
        title: o.title,
        subtitle: `${fmtDayShort.format(o.start)} · ${timeRange(o)} · ${o.calendar}`,
        href: `/kalender/termin/${o.eventId}`,
        icon: "CalendarDays",
      }));
  },
};
