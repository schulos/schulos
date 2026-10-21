// SP2-03 (SP-G-04b): Tagesgrenzen und Ganztag je Jahrgangsstufe – rein, ohne Datenbank. Gilt für die Klassen des Jahrgangs;
// Kurse des Jahrgangs (Wahlpflicht, Förderkurs, Kursband) zählen für die Klassen mit (die Klasse ist dort beschäftigt, SP2-02).
//
// - `maxPerDay`: höchstens so viele belegte Stunden am Tag.
// - `lunchAfterPeriod` N: Mittag nach der N-ten Stunde. Liegt im Zeitraster zwischen N und N+1 schon eine lange Pause
//   (≥ LUNCH_MIN_MINUTES), ist die Mittagspause dort und nichts weiter nötig; sonst ist Stunde N+1 die Mittagsstunde und bleibt frei,
//   sobald danach noch Unterricht liegt („Mittagspause Pflicht bei Unterricht danach“). Nachmittag = nach der Mittagspause.
// - `afternoonsPerWeek`: höchstens so viele Tage mit Unterricht am Nachmittag (braucht `lunchAfterPeriod`).
//
// Alle drei Regeln sind monoton: eine Stunde wegzunehmen verletzt nie eine Regel – wichtig für Tauschen/Verschieben im Solver.

/** Gespeicherte Regel eines Jahrgangs (`timetable_grade_rules`); `null` = keine Grenze. */
export interface GradeRule {
  grade: number;
  maxPerDay: number | null;
  afternoonsPerWeek: number | null;
  lunchAfterPeriod: number | null;
}

/** Wirksame Regel im Zeitraster: Mittagsstunde (frei bei Unterricht danach) und erste Nachmittagsstunde. */
export interface DayRule {
  maxPerDay: number | null;
  afternoonsPerWeek: number | null;
  /** Stunde, die frei bleibt, sobald danach Unterricht liegt; `null` = Pause liegt im Raster bzw. keine Mittagsregel */
  lunchPeriod: number | null;
  /** erste Stunde, die als Nachmittag zählt; `null` = ohne Mittagsangabe (dann keine Nachmittagsgrenze) */
  afternoonFrom: number | null;
}

/** Pause im Zeitraster, die schon als Mittagspause zählt (Vorschlag Q-SP2-9). */
export const LUNCH_MIN_MINUTES = 30;

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const hasRule = (r: Pick<GradeRule, "maxPerDay" | "afternoonsPerWeek" | "lunchAfterPeriod">) =>
  r.maxPerDay !== null || r.afternoonsPerWeek !== null || r.lunchAfterPeriod !== null;

/** Rein: gespeicherte Regel → wirksame Regel im Zeitraster (Stunden mit Beginn/Ende, aufsteigend). */
export function dayRuleFor(rule: Omit<GradeRule, "grade">, periods: readonly { nr: number; startsAt: string; endsAt: string }[]): DayRule | null {
  if (!hasRule(rule)) return null;
  const n = rule.lunchAfterPeriod;
  let lunchPeriod: number | null = null;
  let afternoonFrom: number | null = null;
  if (n !== null) {
    const i = periods.findIndex((p) => p.nr === n);
    const next = i >= 0 ? periods[i + 1] : undefined;
    if (next) {
      const gap = minutes(next.startsAt) - minutes(periods[i]!.endsAt);
      if (gap >= LUNCH_MIN_MINUTES) afternoonFrom = next.nr;
      else {
        lunchPeriod = next.nr;
        afternoonFrom = periods[i + 2]?.nr ?? next.nr + 1;
      }
    } else afternoonFrom = n + 1; // nach der letzten Stunde: es gibt keinen Nachmittag
  }
  return { maxPerDay: rule.maxPerDay, afternoonsPerWeek: n === null ? null : rule.afternoonsPerWeek, lunchPeriod, afternoonFrom };
}

export type DayProblem = "max" | "lunch";

/** Rein: Verstöße eines Tages (belegte Stunden) gegen die Tagesregeln – ohne die Wochengrenze der Nachmittage. */
export function dayProblems(rule: DayRule, occupied: ReadonlySet<number>): DayProblem[] {
  const out: DayProblem[] = [];
  if (rule.maxPerDay !== null && occupied.size > rule.maxPerDay) out.push("max");
  const lunch = rule.lunchPeriod;
  if (lunch !== null && occupied.has(lunch) && [...occupied].some((p) => p > lunch)) out.push("lunch");
  return out;
}

/** Rein: hat der Tag Unterricht am Nachmittag? */
export function isAfternoon(rule: DayRule, occupied: Iterable<number>): boolean {
  if (rule.afternoonFrom === null) return false;
  for (const p of occupied) if (p >= rule.afternoonFrom) return true;
  return false;
}

/** Lesbare Regel für Gründe und Diagnose („höchstens 7 Stunden am Tag“ …). */
export function problemText(rule: DayRule, kind: DayProblem | "afternoons"): string {
  if (kind === "max") return `höchstens ${rule.maxPerDay} Stunden am Tag`;
  if (kind === "lunch") return `${rule.lunchPeriod}. Stunde ist Mittagspause, wenn danach Unterricht liegt`;
  return `höchstens ${rule.afternoonsPerWeek} ${rule.afternoonsPerWeek === 1 ? "Nachmittag" : "Nachmittage"} je Woche`;
}

/**
 * Rein: Welche Regeln verletzt ein Tag, wenn `add` dazukommt? `week` = belegte Stunden je Wochentag vorher (ohne `add`).
 * Liefert leere Liste, wenn es passt. Grundlage für Setzhilfe und Diagnose (der Solver rechnet dasselbe auf seinem Zustand).
 */
export function violationsWith(rule: DayRule, week: ReadonlyMap<number, ReadonlySet<number>>, weekday: number, add: readonly number[]): (DayProblem | "afternoons")[] {
  const before = week.get(weekday) ?? new Set<number>();
  const day = new Set([...before, ...add]);
  const out: (DayProblem | "afternoons")[] = dayProblems(rule, day);
  if (rule.afternoonsPerWeek !== null && !isAfternoon(rule, before) && isAfternoon(rule, day)) {
    let n = 1;
    for (const [wd, ps] of week) if (wd !== weekday && isAfternoon(rule, ps)) n++;
    if (n > rule.afternoonsPerWeek) out.push("afternoons");
  }
  return out;
}

/**
 * Rein: wie viele Wochenstunden die Regeln einer Klasse höchstens erlauben (für die Diagnose „passt nicht in die Woche“).
 * Vormittag = Stunden vor dem Nachmittag (die Mittagsstunde zählt nur an Tagen ohne Nachmittag), Nachmittagstage höchstens
 * `afternoonsPerWeek`; `maxPerDay` deckelt jeden Tag.
 */
export function weeklyCapacity(rule: DayRule, periods: readonly number[], days = 5): number {
  const cap = (n: number) => (rule.maxPerDay === null ? n : Math.min(rule.maxPerDay, n));
  const all = periods.length;
  if (rule.afternoonFrom === null) return days * cap(all);
  const morning = periods.filter((p) => p < rule.afternoonFrom!).length;
  const full = all - (rule.lunchPeriod !== null ? 1 : 0);
  const afternoons = rule.afternoonsPerWeek === null ? days : Math.min(days, rule.afternoonsPerWeek);
  return afternoons * cap(full) + (days - afternoons) * cap(morning);
}

// ---------------------------------------------------------------- Klassen, Kurse, Wochen

/** Tagesgrenzen einer Schule: Regel je Klasse, Jahrgang je Gruppe (Klassen und Kurse), Namen für Gründe. */
export interface DayLimits {
  rules: ReadonlyMap<string, DayRule>;
  gradeOf: ReadonlyMap<string, number>;
  classIds: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
}

/** Rein: Klassen mit Regel, die Stunden dieser Gruppen betreffen – die Klasse selbst bzw. bei Kursen die Klassen des Jahrgangs. */
export function affectedClasses(lim: DayLimits, groupIds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const g of groupIds) {
    if (lim.classIds.has(g)) {
      if (lim.rules.has(g)) out.add(g);
      continue;
    }
    const grade = lim.gradeOf.get(g);
    if (grade === undefined) continue;
    for (const c of lim.rules.keys()) if (lim.gradeOf.get(c) === grade) out.add(c);
  }
  return [...out];
}

/** Rein: belegte Stunden einer Klasse je Wochentag – eigene Stunden und die der Kurse ihres Jahrgangs. */
export function classWeek(lim: DayLimits, classId: string, lessons: Iterable<{ groupId: string; weekday: number; periodNr: number }>): Map<number, Set<number>> {
  const grade = lim.gradeOf.get(classId);
  const week = new Map<number, Set<number>>();
  for (const l of lessons) {
    const mine = l.groupId === classId || (grade !== undefined && !lim.classIds.has(l.groupId) && lim.gradeOf.get(l.groupId) === grade);
    if (!mine) continue;
    if (!week.has(l.weekday)) week.set(l.weekday, new Set());
    week.get(l.weekday)!.add(l.periodNr);
  }
  return week;
}

/** Rein: Gründe, warum Stunden dieser Gruppen im Slot gegen Tagesgrenzen verstoßen („7a: höchstens 7 Stunden am Tag“). */
export function dayLimitReasons(
  lim: DayLimits,
  groupIds: Iterable<string>,
  lessons: readonly { groupId: string; weekday: number; periodNr: number }[],
  weekday: number,
  span: readonly number[],
): string[] {
  const out: string[] = [];
  for (const c of affectedClasses(lim, groupIds)) {
    const rule = lim.rules.get(c)!;
    for (const v of violationsWith(rule, classWeek(lim, c, lessons), weekday, span)) out.push(`${lim.names.get(c) ?? c}: ${problemText(rule, v)}`);
  }
  return out;
}

/** Kurzbeschreibung der Regel („höchstens 7 Std./Tag · höchstens 3 Nachmittage · Mittagspause 7. Stunde“). */
export function ruleSummary(rule: DayRule): string {
  const parts: string[] = [];
  if (rule.maxPerDay !== null) parts.push(`höchstens ${rule.maxPerDay} Std./Tag`);
  if (rule.afternoonsPerWeek !== null) parts.push(`höchstens ${rule.afternoonsPerWeek} ${rule.afternoonsPerWeek === 1 ? "Nachmittag" : "Nachmittage"}`);
  if (rule.lunchPeriod !== null) parts.push(`Mittagspause ${rule.lunchPeriod}. Stunde`);
  return parts.join(" · ");
}
