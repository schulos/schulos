// Deputate (P2b-09): Pflichtstunden, Ermäßigungen/Anrechnungen und Konto Soll ↔ Lehraufträge ↔ verplant je Lehrkraft.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { periods, schoolYears, timetableDeputies, timetableReductions, timetableTeacherDayRules, users, REDUCTION_REASONS, type ReductionReason } from "@/core/db/schema";
import { formInfo, type SchoolForm } from "@/core/school/catalog";
import { ValidationError } from "@/modules/verwaltung/users";
import { planningYear, type TeacherTotals } from "./verteilung";
import { hasTeacherRule, type TeacherDayRule, type TeacherLimits } from "./lehrkraftregeln";
import { deputyOn, deputyTerms, obligationFromPercent, type DeputySettings, type DeputyTerm, type Reduction } from "./deputat-rechnung";

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

export { deputyOn, deputyTerms, obligationFromPercent, reductionActiveOn, termOn, type DeputyCalc, type DeputySettings, type DeputyTerm, type Reduction } from "./deputat-rechnung";

const round1 = (x: number) => Math.round(x * 10) / 10;

export interface DeputyAccount extends TeacherTotals {
  /** Pflichtstunden am Stichtag (im 2. Halbjahr ggf. die abweichende Pflicht) */
  obligation: number;
  /** Pflichtstunden am Stichtag aus der Vorgabe der Schulform (keine eigene Angabe) */
  isDefault: boolean;
  /** SP3-DEP: eigene Angaben (für die Pflege-Formulare und die eigene Rechnung) */
  settings: DeputySettings;
  /** Halbjahr am Stichtag (2 erst ab `term2_starts_on`; ohne Angabe im Schuljahr immer 1) */
  term: 1 | 2;
  /** Ermäßigungen/Anrechnungen, die am Stichtag gelten */
  reductions: Reduction[];
  /** SP3-DEP: Ermäßigungen/Anrechnungen, die am Stichtag (noch/nicht mehr) nicht gelten */
  otherReductions: Reduction[];
  /** Pflichtstunden − Ermäßigungen/Anrechnungen am Stichtag */
  target: number;
  /** Lehraufträge − Soll: positiv = Überhang, negativ = Unterdeckung */
  balance: number;
  /** SP3-DEP: beide Halbjahre, wenn sich Pflicht oder Soll am Halbjahresbeginn unterscheiden; sonst `null` */
  terms: DeputyTerm[] | null;
  /** SP2-04: Tagesregel (höchstens Stunden am Tag / Anwesenheitstage); `null` = keine */
  dayRule: TeacherDayRule | null;
}

/**
 * Konto je Lehrkraft am Stichtag `refYmd` (SP3-DEP: Pflicht des Halbjahrs, Anrechnungen mit Gültigkeit); `totals` kommen aus
 * distribution() desselben Schuljahres und Stichtags (`d.refYmd`).
 */
export async function deputyAccounts(db: Db, schoolYearId: string, totals: TeacherTotals[], fallback: number, refYmd: string): Promise<DeputyAccount[]> {
  const [deps, reds, rules, [year]] = await Promise.all([
    db.select().from(timetableDeputies).where(eq(timetableDeputies.schoolYearId, schoolYearId)),
    db.select().from(timetableReductions).where(eq(timetableReductions.schoolYearId, schoolYearId)).orderBy(asc(timetableReductions.createdAt)),
    listTeacherRules(db, schoolYearId),
    db.select({ startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn, term2StartsOn: schoolYears.term2StartsOn }).from(schoolYears).where(eq(schoolYears.id, schoolYearId)),
  ]);
  const own = new Map<string, DeputySettings>(deps.map((d) => [d.teacherId, { obligation: d.obligation, employmentPercent: d.employmentPercent, obligationTerm2: d.obligationTerm2 }]));
  const term2 = year?.term2StartsOn ?? null;
  return totals.map((t) => {
    const settings = own.get(t.id);
    const mine: Reduction[] = reds
      .filter((r) => r.teacherId === t.id)
      .map(({ id, reason, hours, note, validFrom, validUntil }) => ({ id, reason, hours, note, validFrom, validUntil }));
    const c = deputyOn(settings, mine, fallback, refYmd, term2);
    return {
      ...t,
      obligation: c.obligation,
      isDefault: c.isDefault,
      settings: settings ?? { obligation: null, employmentPercent: null, obligationTerm2: null },
      term: c.term,
      reductions: c.active,
      otherReductions: c.other,
      target: c.target,
      balance: round1(t.assigned - c.target),
      terms: year ? deputyTerms(settings, mine, fallback, year) : null,
      dayRule: rules.get(t.id) ?? null,
    };
  });
}

const halfSteps = (x: number) => Number.isFinite(x) && Number.isInteger(x * 2);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

async function checkRefs(db: Db, schoolYearId: string, teacherId: string, fe: Record<string, string>) {
  const [[y], [t]] = await Promise.all([
    db.select({ id: schoolYears.id, startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn, term2StartsOn: schoolYears.term2StartsOn }).from(schoolYears).where(eq(schoolYears.id, schoolYearId)),
    db.select({ role: users.role }).from(users).where(eq(users.id, teacherId)),
  ]);
  if (!y) fe.schoolYearId = "Schuljahr gibt es nicht";
  if (t?.role !== "lehrkraft") fe.teacherId = "Lehrkraft gibt es nicht";
  return y;
}

export interface DeputyInput {
  /** `null` = Vorgabe der Schulform – oder aus `employmentPercent` berechnet, wenn ein Anteil angegeben ist */
  obligation: number | null;
  employmentPercent: number | null;
  obligationTerm2: number | null;
}

/**
 * SP3-DEP: Pflichtstunden, Teilzeit-Anteil und Pflicht 2. Halbjahr setzen; alles leer = zurück zur Vorgabe der Schulform (Zeile entfällt).
 * Rechenhilfe: Anteil ohne Pflichtstunden → Pflicht = Vorgabe (`fallback`) × Anteil, gespeichert wird die Stundenzahl.
 */
export async function setDeputy(db: Db, actorId: string, schoolYearId: string, teacherId: string, input: DeputyInput, fallback: number): Promise<void> {
  const fe: Record<string, string> = {};
  const hoursOk = (x: number | null) => x === null || (halfSteps(x) && x >= 0 && x <= 40);
  const p = input.employmentPercent;
  if (p !== null && (!Number.isFinite(p) || Math.abs(p * 10 - Math.round(p * 10)) > 1e-9 || p <= 0 || p > 100)) fe.employmentPercent = "Anteil über 0 bis 100 %, höchstens eine Nachkommastelle";
  if (!hoursOk(input.obligation)) fe.obligation = "0 bis 40 Stunden in halben Schritten";
  if (!hoursOk(input.obligationTerm2)) fe.obligationTerm2 = "0 bis 40 Stunden in halben Schritten";
  const year = await checkRefs(db, schoolYearId, teacherId, fe);
  if (year && input.obligationTerm2 !== null && !year.term2StartsOn) fe.obligationTerm2 = "Im Schuljahr ist kein Beginn des 2. Halbjahrs eingetragen (Stammdaten → Schuljahre)";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const obligation = input.obligation ?? (p !== null ? obligationFromPercent(fallback, p) : null);
  const values = { obligation, employmentPercent: p, obligationTerm2: input.obligationTerm2 };
  const where = and(eq(timetableDeputies.schoolYearId, schoolYearId), eq(timetableDeputies.teacherId, teacherId));
  if (obligation === null && p === null && input.obligationTerm2 === null) await db.delete(timetableDeputies).where(where);
  else
    await db
      .insert(timetableDeputies)
      .values({ schoolYearId, teacherId, ...values })
      .onConflictDoUpdate({ target: [timetableDeputies.schoolYearId, timetableDeputies.teacherId], set: values });
  await audit(db, actorId, "stundenplan.deputy.obligation", teacherId, values);
}

export interface ReductionInput {
  schoolYearId: string;
  teacherId: string;
  reason: string;
  hours: number;
  note: string | null;
  /** SP3-DEP: optional, `YYYY-MM-DD` im Schuljahr */
  validFrom?: string | null;
  validUntil?: string | null;
}

export async function addReduction(db: Db, actorId: string, input: ReductionInput): Promise<string> {
  const fe: Record<string, string> = {};
  if (!(REDUCTION_REASONS as readonly string[]).includes(input.reason)) fe.reason = "Grund wählen";
  if (!halfSteps(input.hours) || input.hours <= 0 || input.hours > 30) fe.hours = "0,5 bis 30 Stunden in halben Schritten";
  const note = input.note?.trim() || null;
  if (note && note.length > 80) fe.note = "höchstens 80 Zeichen";
  const validFrom = input.validFrom?.trim() || null;
  const validUntil = input.validUntil?.trim() || null;
  if (validFrom && !YMD.test(validFrom)) fe.validFrom = "Datum angeben";
  if (validUntil && !YMD.test(validUntil)) fe.validUntil = "Datum angeben";
  const year = await checkRefs(db, input.schoolYearId, input.teacherId, fe);
  if (year) {
    const inYear = (d: string) => d >= year.startsOn && d <= year.endsOn;
    if (validFrom && !fe.validFrom && !inYear(validFrom)) fe.validFrom = "Datum im Schuljahr";
    if (validUntil && !fe.validUntil && !inYear(validUntil)) fe.validUntil = "Datum im Schuljahr";
  }
  if (validFrom && validUntil && !fe.validFrom && !fe.validUntil && validFrom > validUntil) fe.validUntil = "„gültig bis“ liegt vor „gültig ab“";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db
    .insert(timetableReductions)
    .values({ schoolYearId: input.schoolYearId, teacherId: input.teacherId, reason: input.reason as ReductionReason, hours: input.hours, note, validFrom, validUntil })
    .returning({ id: timetableReductions.id });
  await audit(db, actorId, "stundenplan.deputy.reduction_add", input.teacherId, { reason: input.reason, hours: input.hours, validFrom, validUntil });
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
