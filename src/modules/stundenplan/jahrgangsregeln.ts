// SP2-03: Tagesgrenzen und Ganztag je Jahrgangsstufe – Pflege (Recht `stundenplan.manage` prüft die Server Action) und Laden für
// Solver, Setzhilfe und Diagnose. Ohne Personenbezug (NO_PERSONAL_DATA); Vorgaben aus dem Schulform-Katalog.
import { asc, eq, inArray, isNotNull, and } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, periods, timetableGradeRules } from "@/core/db/schema";
import { gradeRulesTemplate } from "@/core/school/templates";
import { readSchoolSettings } from "@/core/settings";
import { ValidationError } from "@/modules/verwaltung/users";
import { dayRuleFor, hasRule, type DayLimits, type DayRule, type GradeRule } from "./tagesgrenzen";

/** Gruppenarten, deren Stunden für die Klassen ihres Jahrgangs zählen (wie im Solver, SP2-02). */
export const DAY_LIMIT_COURSE_KINDS = new Set(["kurs", "wahlpflicht", "foerderkurs"]);

/** Jahrgänge mit Klassen (aufsteigend) – für sie lassen sich Regeln pflegen. */
export async function classGrades(db: Db): Promise<number[]> {
  const rows = await db
    .selectDistinct({ g: groups.gradeLevel })
    .from(groups)
    .where(and(eq(groups.kind, "klasse"), isNotNull(groups.gradeLevel)))
    .orderBy(asc(groups.gradeLevel));
  return rows.map((r) => r.g!).filter((g) => Number.isInteger(g));
}

export async function listGradeRules(db: Db): Promise<GradeRule[]> {
  const rows = await db.select().from(timetableGradeRules).orderBy(asc(timetableGradeRules.gradeLevel));
  return rows.map((r) => ({ grade: r.gradeLevel, maxPerDay: r.maxPerDay, afternoonsPerWeek: r.afternoonsPerWeek, lunchAfterPeriod: r.lunchAfterPeriod }));
}

/** Prüft eine Regel gegen das Zeitraster (Stundenzahl) – Fehler je Feld mit Jahrgang im Schlüssel. */
export function validateGradeRule(r: GradeRule, periodCount: number): Record<string, string> {
  const fe: Record<string, string> = {};
  const intIn = (v: number | null, lo: number, hi: number) => v === null || (Number.isInteger(v) && v >= lo && v <= hi);
  if (!intIn(r.maxPerDay, 1, periodCount)) fe[`max_${r.grade}`] = `Jahrgang ${r.grade}: 1 bis ${periodCount} Stunden`;
  if (!intIn(r.afternoonsPerWeek, 0, 5)) fe[`pm_${r.grade}`] = `Jahrgang ${r.grade}: 0 bis 5 Nachmittage`;
  if (!intIn(r.lunchAfterPeriod, 1, Math.max(1, periodCount - 1))) fe[`lunch_${r.grade}`] = `Jahrgang ${r.grade}: Mittag nach der 1. bis ${periodCount - 1}. Stunde`;
  if (r.afternoonsPerWeek !== null && r.lunchAfterPeriod === null) fe[`pm_${r.grade}`] = `Jahrgang ${r.grade}: Nachmittage brauchen die Angabe „Mittag nach der … Stunde“`;
  return fe;
}

/** Speichert die Regeln aller übergebenen Jahrgänge (leer = keine Grenze, Zeile entfällt). */
export async function saveGradeRules(db: Db, actorId: string, rules: GradeRule[]): Promise<void> {
  const periodCount = (await db.select({ nr: periods.nr }).from(periods)).length;
  const fe: Record<string, string> = {};
  for (const r of rules) Object.assign(fe, validateGradeRule(r, periodCount));
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db.transaction(async (tx) => {
    const grades = rules.map((r) => r.grade);
    if (grades.length) await tx.delete(timetableGradeRules).where(inArray(timetableGradeRules.gradeLevel, grades));
    const rows = rules.filter(hasRule).map((r) => ({ gradeLevel: r.grade, maxPerDay: r.maxPerDay, afternoonsPerWeek: r.afternoonsPerWeek, lunchAfterPeriod: r.lunchAfterPeriod }));
    if (rows.length) await tx.insert(timetableGradeRules).values(rows);
  });
  await audit(db, actorId, "stundenplan.tagesgrenzen.save", null, { grades: rules.filter(hasRule).map((r) => r.grade) });
}

/** Übernimmt die Vorgaben der Schulform für alle Jahrgänge mit Klassen (überschreibt deren Regeln). Gibt die Jahrgänge zurück. */
export async function applyGradeRuleDefaults(db: Db, actorId: string): Promise<number[]> {
  const [{ profile }, grades, periodRows] = await Promise.all([readSchoolSettings(db), classGrades(db), db.select({ nr: periods.nr }).from(periods)]);
  const template = gradeRulesTemplate(profile.form, grades, periodRows.length);
  const rules = grades.map((g) => template.find((t) => t.grade === g) ?? { grade: g, maxPerDay: null, afternoonsPerWeek: null, lunchAfterPeriod: null });
  await saveGradeRules(db, actorId, rules);
  return grades;
}

/**
 * Wirksame Tagesgrenzen je Klasse im aktuellen Zeitraster, dazu Jahrgang je Gruppe (Klassen und Kurse) – für Solver-Eingabe,
 * Setzhilfe und Diagnose. Ohne gepflegte Regeln: leere Regeln (alles wie vorher).
 */
export async function loadDayLimits(db: Db): Promise<DayLimits> {
  const [rules, periodRows, groupRows] = await Promise.all([
    listGradeRules(db),
    db.select({ nr: periods.nr, startsAt: periods.startsAt, endsAt: periods.endsAt }).from(periods).orderBy(asc(periods.nr)),
    db.select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel }).from(groups).where(isNotNull(groups.gradeLevel)),
  ]);
  const byGrade = new Map<number, DayRule>();
  for (const r of rules) {
    const d = dayRuleFor(r, periodRows);
    if (d) byGrade.set(r.grade, d);
  }
  const out = { rules: new Map<string, DayRule>(), gradeOf: new Map<string, number>(), classIds: new Set<string>(), names: new Map<string, string>() };
  if (!byGrade.size) return out;
  for (const g of groupRows) {
    if (g.kind !== "klasse" && !DAY_LIMIT_COURSE_KINDS.has(g.kind)) continue;
    out.gradeOf.set(g.id, g.gradeLevel!);
    out.names.set(g.id, g.name);
    if (g.kind !== "klasse") continue;
    out.classIds.add(g.id);
    const rule = byGrade.get(g.gradeLevel!);
    if (rule) out.rules.set(g.id, rule);
  }
  return out;
}
