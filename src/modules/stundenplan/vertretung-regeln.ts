// SP2-07: Tagesregeln der Lehrkräfte (SP2-04) auch bei Vertretungen – eine Vertretung, die „höchstens n Stunden am Tag“ oder
// „höchstens n Anwesenheitstage“ verletzt, wird nicht vorgeschlagen und nicht gespeichert.
import { and, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { schoolYears, timetableLessons } from "@/core/db/schema";
import { weekdayMon0 } from "@/core/time";
import { listTeacherRules } from "./deputate";
import { teacherProblemText, teacherViolationsWith } from "./lehrkraftregeln";

/**
 * Lehrkräfte aus `teacherIds`, die eine zusätzliche Stunde `periodNr` an `date` gegen ihre Tagesregel verstößt – mit lesbarem
 * Grund. `today` = Stunden, die sie an dem Tag tatsächlich halten (nach Vertretungen/Verlegungen); die übrigen Wochentage
 * zählen nach dem Regelplan.
 */
export async function dayRuleBlocks(db: Db, date: string, periodNr: number, teacherIds: readonly string[], today: ReadonlyMap<string, readonly number[]>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (teacherIds.length === 0) return out;
  const [year] = await db
    .select({ id: schoolYears.id })
    .from(schoolYears)
    .where(and(lte(schoolYears.startsOn, date), gte(schoolYears.endsOn, date)));
  if (!year) return out;
  const rules = await listTeacherRules(db, year.id);
  const ids = teacherIds.filter((t) => rules.has(t));
  if (ids.length === 0) return out;
  const regular = await db
    .select({ teacherId: timetableLessons.teacherId, weekday: timetableLessons.weekday, periodNr: timetableLessons.periodNr })
    .from(timetableLessons)
    .where(and(inArray(timetableLessons.teacherId, ids), lte(timetableLessons.validFrom, date), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, date))));
  const weekday = weekdayMon0(date);
  for (const t of ids) {
    const week = new Map<number, Set<number>>();
    for (const r of regular) if (r.teacherId === t && r.weekday !== weekday) week.set(r.weekday, (week.get(r.weekday) ?? new Set()).add(r.periodNr));
    week.set(weekday, new Set(today.get(t) ?? []));
    const rule = rules.get(t)!;
    const problems = teacherViolationsWith(rule, week, weekday, [periodNr]);
    if (problems.length) out.set(t, `Tagesregel: ${teacherProblemText(rule, problems[0]!)}`);
  }
  return out;
}
