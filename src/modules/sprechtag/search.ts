import { and, gte, ilike } from "drizzle-orm";
import { sprechtagEvents } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import type { SearchProvider } from "@/core/search";
import { toBerlinDate } from "@/core/time";
import { MANAGE, OFFER, bookingStudents, formatEventDay } from "./service";

/**
 * Sprechtage nach Titel (P4-53): Verwaltung alle, Lehrkräfte und buchende Familien bzw. eigenständige Schüler:innen die
 * kommenden – keine Termine und keine Namen in der Suche.
 */
export const sprechtagSearch: SearchProvider = {
  moduleId: "sprechtag",
  async search(db, { perms }, q) {
    const manage = hasPermission(perms, MANAGE);
    const offer = hasPermission(perms, OFFER);
    const family = !manage && !offer && (await bookingStudents(db, perms)).length > 0;
    if (!manage && !offer && !family) return [];
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const conds = [ilike(sprechtagEvents.title, like)];
    if (!manage) conds.push(gte(sprechtagEvents.date, toBerlinDate(new Date())));
    const rows = await db.select().from(sprechtagEvents).where(and(...conds)).orderBy(sprechtagEvents.date).limit(5);
    return rows.map((e) => ({
      group: "Elternsprechtag",
      id: `sprechtag:${e.id}`,
      title: e.title,
      subtitle: `${formatEventDay(e.date)} · ${e.startsAt}–${e.endsAt} Uhr`,
      href: family ? `/sprechtag/buchen?e=${e.id}` : `/sprechtag/${e.id}`,
      icon: "CalendarClock",
    }));
  },
};
