// SP2-04 (SP-G-05): Tagesregeln je Lehrkraft – höchstens n Stunden am Tag, höchstens n Anwesenheitstage in der Woche (Teilzeit).
// Reine Regeln, ohne Datenbank (für Solver-Vorprüfung, Setzhilfe und Diagnose); Pflege und Laden in `deputate.ts`. Personaldaten wie das Deputat: sieht und pflegt die
// Planung (`stundenplan.manage`, geprüft in der Server Action), die Lehrkraft sieht ihre eigene Regel unter „Mein Deputat“.
//
// Beide Regeln sind monoton: eine Stunde wegzunehmen verletzt nie eine Regel (wie die Tagesgrenzen der Klassen, SP2-03).
// Bänder/Kopplungen: eine Lehrkraft in mehreren Gruppen derselben Stunde zählt die Stunde einmal.

/** Regel einer Lehrkraft; `null` = keine Grenze. */
export interface TeacherDayRule {
  maxPerDay: number | null;
  maxDays: number | null;
}

export type TeacherProblem = "max" | "days";

export const hasTeacherRule = (r: TeacherDayRule) => r.maxPerDay !== null || r.maxDays !== null;

/** Rein: Verstöße eines Tages (belegte Stunden) gegen „höchstens n Stunden am Tag“. */
export function teacherDayProblems(rule: TeacherDayRule, occupied: ReadonlySet<number>): TeacherProblem[] {
  return rule.maxPerDay !== null && occupied.size > rule.maxPerDay ? ["max"] : [];
}

/** Rein: Anwesenheitstage einer Woche (Tage mit mindestens einer Stunde). */
export function presenceDays(week: ReadonlyMap<number, ReadonlySet<number>>): number {
  let n = 0;
  for (const ps of week.values()) if (ps.size) n++;
  return n;
}

/**
 * Rein: Welche Regeln verletzt die Lehrkraft, wenn `add` am Tag `weekday` dazukommt? `week` = belegte Stunden je Wochentag vorher.
 * Grundlage für Setzhilfe und Diagnose (der Solver rechnet dasselbe auf seinem Zustand).
 */
export function teacherViolationsWith(rule: TeacherDayRule, week: ReadonlyMap<number, ReadonlySet<number>>, weekday: number, add: readonly number[]): TeacherProblem[] {
  const before = week.get(weekday) ?? new Set<number>();
  const out = teacherDayProblems(rule, new Set([...before, ...add]));
  if (rule.maxDays !== null && !before.size && add.length) {
    let n = 1;
    for (const [wd, ps] of week) if (wd !== weekday && ps.size) n++;
    if (n > rule.maxDays) out.push("days");
  }
  return out;
}

/** Lesbare Regel für Gründe und Diagnose. */
export function teacherProblemText(rule: TeacherDayRule, kind: TeacherProblem): string {
  if (kind === "max") return `höchstens ${rule.maxPerDay} Stunden am Tag`;
  return `höchstens ${rule.maxDays} ${rule.maxDays === 1 ? "Anwesenheitstag" : "Anwesenheitstage"} je Woche`;
}

/** Kurzbeschreibung („höchstens 5 Std./Tag · höchstens 3 Tage“). */
export function teacherRuleSummary(rule: TeacherDayRule): string {
  const parts: string[] = [];
  if (rule.maxPerDay !== null) parts.push(`höchstens ${rule.maxPerDay} Std./Tag`);
  if (rule.maxDays !== null) parts.push(`höchstens ${rule.maxDays} ${rule.maxDays === 1 ? "Tag" : "Tage"}`);
  return parts.join(" · ");
}

/** Rein: wie viele Wochenstunden die Regel höchstens erlaubt. */
export function teacherWeeklyCapacity(rule: TeacherDayRule, periodCount: number, days = 5): number {
  const perDay = rule.maxPerDay === null ? periodCount : Math.min(rule.maxPerDay, periodCount);
  return (rule.maxDays === null ? days : Math.min(days, rule.maxDays)) * perDay;
}

/** Tagesregeln einer Schule: Regel je Lehrkraft, Kürzel für Gründe. */
export interface TeacherLimits {
  rules: ReadonlyMap<string, TeacherDayRule>;
  names: ReadonlyMap<string, string>;
}

/** Rein: belegte Stunden einer Lehrkraft je Wochentag. */
export function teacherWeek(teacherId: string, lessons: Iterable<{ teacherId: string | null; weekday: number; periodNr: number }>): Map<number, Set<number>> {
  const week = new Map<number, Set<number>>();
  for (const l of lessons) {
    if (l.teacherId !== teacherId) continue;
    if (!week.has(l.weekday)) week.set(l.weekday, new Set());
    week.get(l.weekday)!.add(l.periodNr);
  }
  return week;
}

/** Rein: Gründe, warum Stunden dieser Lehrkräfte im Slot gegen ihre Tagesregel verstoßen („LIN: höchstens 5 Stunden am Tag“). */
export function teacherLimitReasons(
  lim: TeacherLimits,
  teacherIds: Iterable<string | null>,
  lessons: readonly { teacherId: string | null; weekday: number; periodNr: number }[],
  weekday: number,
  span: readonly number[],
): string[] {
  const out: string[] = [];
  for (const t of new Set(teacherIds)) {
    const rule = t ? lim.rules.get(t) : undefined;
    if (!t || !rule) continue;
    for (const v of teacherViolationsWith(rule, teacherWeek(t, lessons), weekday, span)) out.push(`${lim.names.get(t) ?? t}: ${teacherProblemText(rule, v)}`);
  }
  return out;
}
