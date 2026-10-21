// Deputate (P2b-09): Pflichtstunden, Ermäßigungen/Anrechnungen und Konto Soll ↔ Lehraufträge ↔ verplant je Lehrkraft.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { periods, schoolYears, timetableDeputies, timetableReductions, timetableTeacherDayRules, users, REDUCTION_REASONS, type ReductionReason } from "@/core/db/schema";
import { formInfo, type SchoolForm } from "@/core/school/catalog";
import { ValidationError } from "@/modules/verwaltung/users";
import { planningYear, type TeacherTotals } from "./verteilung";
import { hasTeacherRule, type TeacherDayRule, type TeacherLimits } from "./lehrkraftregeln";

export const REDUCTION_LABELS: Record<ReductionReason, string> = {
  alter: "Altersermäßigung",
  schulleitung: "Schulleitung",
  koordination: "Koordination / Stufenleitung",
  klassenleitung: "Klassenleitung",
  fachleitung: "Fachbereichs- / Fachleitung",
  ausbildung: "Ausbildung (Mentoring)",
  personalrat: "Personalrat",
  sonstige_aufgabe: "sonstige Aufgabe",
  sonstige_ermaessigung: "sonstige Ermäßigung",
  stundenplanung: "Stundenplanung",
};

/** Ermäßigung (persönlich) oder Anrechnung (für eine Aufgabe) */
export function reductionKind(reason: ReductionReason): "Ermäßigung" | "Anrechnung" {
  return reason === "alter" || reason === "sonstige_ermaessigung" ? "Ermäßigung" : "Anrechnung";
}

export function defaultObligation(form: SchoolForm): number {
  return formInfo(form).obligation;
}

export interface Reduction {
  id: string;
  reason: ReductionReason;
  hours: number;
  note: string | null;
}

export interface DeputyAccount extends TeacherTotals {
  obligation: number;
  /** Pflichtstunden aus der Vorgabe der Schulform (keine eigene Angabe) */
  isDefault: boolean;
  reductions: Reduction[];
  /** Pflichtstunden − Ermäßigungen/Anrechnungen */
  target: number;
  /** Lehraufträge − Soll: positiv = Überhang, negativ = Unterdeckung */
  balance: number;
  /** SP2-04: Tagesregel (höchstens Stunden am Tag / Anwesenheitstage); `null` = keine */
  dayRule: TeacherDayRule | null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Konto je Lehrkraft; `totals` kommen aus distribution() desselben Schuljahres. */
export async function deputyAccounts(db: Db, schoolYearId: string, totals: TeacherTotals[], fallback: number): Promise<DeputyAccount[]> {
  const [deps, reds, rules] = await Promise.all([
    db.select().from(timetableDeputies).where(eq(timetableDeputies.schoolYearId, schoolYearId)),
    db.select().from(timetableReductions).where(eq(timetableReductions.schoolYearId, schoolYearId)).orderBy(asc(timetableReductions.createdAt)),
    listTeacherRules(db, schoolYearId),
  ]);
  const own = new Map(deps.map((d) => [d.teacherId, d.obligation]));
  return totals.map((t) => {
    const obligation = own.get(t.id) ?? fallback;
    const reductions = reds.filter((r) => r.teacherId === t.id).map(({ id, reason, hours, note }) => ({ id, reason, hours, note }));
    const target = round1(Math.max(0, obligation - reductions.reduce((s, r) => s + r.hours, 0)));
    return { ...t, obligation, isDefault: !own.has(t.id), reductions, target, balance: round1(t.assigned - target), dayRule: rules.get(t.id) ?? null };
  });
}

const halfSteps = (x: number) => Number.isFinite(x) && Number.isInteger(x * 2);

async function checkRefs(db: Db, schoolYearId: string, teacherId: string, fe: Record<string, string>) {
  const [[y], [t]] = await Promise.all([
    db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, schoolYearId)),
    db.select({ role: users.role }).from(users).where(eq(users.id, teacherId)),
  ]);
  if (!y) fe.schoolYearId = "Schuljahr gibt es nicht";
  if (t?.role !== "lehrkraft") fe.teacherId = "Lehrkraft gibt es nicht";
}

/** Pflichtstunden setzen; `null` = zurück zur Vorgabe der Schulform. */
export async function setObligation(db: Db, actorId: string, schoolYearId: string, teacherId: string, obligation: number | null): Promise<void> {
  const fe: Record<string, string> = {};
  if (obligation !== null && (!halfSteps(obligation) || obligation < 0 || obligation > 40)) fe.obligation = "0 bis 40 Stunden in halben Schritten";
  await checkRefs(db, schoolYearId, teacherId, fe);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const where = and(eq(timetableDeputies.schoolYearId, schoolYearId), eq(timetableDeputies.teacherId, teacherId));
  if (obligation === null) await db.delete(timetableDeputies).where(where);
  else
    await db
      .insert(timetableDeputies)
      .values({ schoolYearId, teacherId, obligation })
      .onConflictDoUpdate({ target: [timetableDeputies.schoolYearId, timetableDeputies.teacherId], set: { obligation } });
  await audit(db, actorId, "stundenplan.deputy.obligation", teacherId, { obligation });
}

export interface ReductionInput {
  schoolYearId: string;
  teacherId: string;
  reason: string;
  hours: number;
  note: string | null;
}

export async function addReduction(db: Db, actorId: string, input: ReductionInput): Promise<string> {
  const fe: Record<string, string> = {};
  if (!(REDUCTION_REASONS as readonly string[]).includes(input.reason)) fe.reason = "Grund wählen";
  if (!halfSteps(input.hours) || input.hours <= 0 || input.hours > 30) fe.hours = "0,5 bis 30 Stunden in halben Schritten";
  const note = input.note?.trim() || null;
  if (note && note.length > 80) fe.note = "höchstens 80 Zeichen";
  await checkRefs(db, input.schoolYearId, input.teacherId, fe);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db
    .insert(timetableReductions)
    .values({ schoolYearId: input.schoolYearId, teacherId: input.teacherId, reason: input.reason as ReductionReason, hours: input.hours, note })
    .returning({ id: timetableReductions.id });
  await audit(db, actorId, "stundenplan.deputy.reduction_add", input.teacherId, { reason: input.reason, hours: input.hours });
  return row!.id;
}

export async function deleteReduction(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableReductions).where(eq(timetableReductions.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.deputy.reduction_delete", old.teacherId, { reason: old.reason, hours: old.hours });
}

// ---------------------------------------------------------------- Tagesregeln je Lehrkraft (SP2-04)

/** Regeln eines Schuljahres je Lehrkraft. */
export async function listTeacherRules(db: Db, schoolYearId: string): Promise<Map<string, TeacherDayRule>> {
  const rows = await db.select().from(timetableTeacherDayRules).where(eq(timetableTeacherDayRules.schoolYearId, schoolYearId));
  return new Map(rows.map((r) => [r.teacherId, { maxPerDay: r.maxPerDay, maxDays: r.maxDays }]));
}

/** Prüft eine Regel gegen die Stunden im Zeitraster und die fünf Schultage. */
export function validateTeacherRule(r: TeacherDayRule, periodCount: number): Record<string, string> {
  const fe: Record<string, string> = {};
  const intIn = (v: number | null, lo: number, hi: number) => v === null || (Number.isInteger(v) && v >= lo && v <= hi);
  if (!intIn(r.maxPerDay, 1, Math.max(1, periodCount))) fe.maxPerDay = `1 bis ${Math.max(1, periodCount)} Stunden`;
  if (!intIn(r.maxDays, 1, 5)) fe.maxDays = "1 bis 5 Tage";
  return fe;
}

/** Tagesregel setzen; beide Felder leer = keine Regel (Zeile entfällt). */
export async function saveTeacherRule(db: Db, actorId: string, schoolYearId: string, teacherId: string, rule: TeacherDayRule): Promise<void> {
  const [[y], [t], periodRows] = await Promise.all([
    db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, schoolYearId)),
    db.select({ role: users.role }).from(users).where(eq(users.id, teacherId)),
    db.select({ nr: periods.nr }).from(periods),
  ]);
  const fe = validateTeacherRule(rule, periodRows.length);
  if (!y) fe.schoolYearId = "Schuljahr gibt es nicht";
  if (t?.role !== "lehrkraft") fe.teacherId = "Lehrkraft gibt es nicht";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const where = and(eq(timetableTeacherDayRules.schoolYearId, schoolYearId), eq(timetableTeacherDayRules.teacherId, teacherId));
  if (!hasTeacherRule(rule)) await db.delete(timetableTeacherDayRules).where(where);
  else
    await db
      .insert(timetableTeacherDayRules)
      .values({ schoolYearId, teacherId, ...rule })
      .onConflictDoUpdate({ target: [timetableTeacherDayRules.schoolYearId, timetableTeacherDayRules.teacherId], set: rule });
  await audit(db, actorId, "stundenplan.deputy.day_rule", teacherId, { maxPerDay: rule.maxPerDay, maxDays: rule.maxDays });
}

/** Regeln des Planungsjahres (bzw. `schoolYearId`) mit Kürzeln – für Setzhilfe und Diagnose. Ohne Regeln: leer. */
export async function loadTeacherLimits(db: Db, schoolYearId?: string): Promise<TeacherLimits> {
  const yearId = schoolYearId ?? (await planningYear(db))?.id;
  const rules = yearId ? await listTeacherRules(db, yearId) : new Map<string, TeacherDayRule>();
  if (!rules.size) return { rules, names: new Map() };
  const rows = await db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")).orderBy(asc(users.id));
  return { rules, names: new Map(rows.filter((r) => rules.has(r.id)).map((r) => [r.id, r.code ?? r.name])) };
}
