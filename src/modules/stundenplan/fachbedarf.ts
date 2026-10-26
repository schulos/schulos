// SP2-12 (Projektleitung 2026-10-19): Fachbedarf & Vorsorge – je Fach Bedarf (Lehraufträge, für Klassen mindestens die Stundentafel)
// gegen Versorgung (Deputat der Lehrkräfte mit dem Lehrfach, Ermäßigungen/Anrechnungen schon abgezogen), Ampel und Empfehlung; dazu die
// Prognose fürs nächste Schuljahr (Klassen rücken auf, Klassenzahl je Jahrgang anpassbar, bekannte Abgänge/Zugänge als Datum + Stunden).
// Rechte: Details (Namen, Abgänge) nur `stundenplan.manage`; `stundenplan.forecast_view` (Schulleitung) bekommt nur Summen je Fach –
// die Funktionen bauen die aggregierte Fassung ohne Personenfelder, statt sie erst in der Anzeige wegzulassen.
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { readSchoolSettings } from "@/core/settings";
import { isCalendarDate } from "@/core/time";
import { schoolYears, subjects, timetableForecastGrades, timetableStaffChanges, users, type StaffChangeKind } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { defaultObligation, deputyAccounts } from "./deputate";
import { teacherSubjectMap } from "./lehrfaecher";
import { distribution, planningYear, type Assignment } from "./verteilung";

const round1 = (x: number) => Math.round(x * 10) / 10;

export type NeedTone = "success" | "warn" | "danger";

/** Ampel: gedeckt = grün; Lücke bis max(2 Std., 10 % des Bedarfs) = gelb; größer oder gar keine Lehrkraft = rot. */
export function needTone(demand: number, supply: number, teacherCount: number): NeedTone {
  if (demand <= 0) return "success";
  if (teacherCount === 0) return "danger";
  const gap = demand - supply;
  if (gap <= 0.05) return "success";
  return gap <= Math.max(2, demand * 0.1) ? "warn" : "danger";
}

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

/** Empfehlungstexte je Fach (ohne Namen). */
export function adviceFor(name: string, demand: number, supply: number, teacherCount: number): string[] {
  const out: string[] = [];
  if (demand <= 0) return out;
  const balance = round1(supply - demand);
  if (teacherCount === 0) out.push(`${name}: keine Lehrkraft mit diesem Lehrfach – Lehrfächer pflegen oder Einstellung/Abordnung prüfen`);
  else if (balance < 0) out.push(`${name}: −${num.format(-balance)} Std. – Einstellung, Abordnung oder Mehrarbeit prüfen`);
  if (teacherCount === 1) out.push(`${name}: nur eine Lehrkraft deckt das Fach – bei Ausfall keine fachgleiche Vertretung`);
  return out;
}

// ---------------------------------------------------------------- Berechnung (rein)

export interface CoverageTeacher {
  id: string;
  code: string | null;
  name: string;
  /** Soll nach Ermäßigungen/Anrechnungen */
  target: number;
}

export interface CoverageInput {
  /** Fächer in Anzeigereihenfolge */
  subjects: { id: string; name: string; color: string }[];
  /** Lehraufträge, die am Stichtag gelten */
  assignments: Pick<Assignment, "id" | "subjectId" | "hours" | "bandId" | "groups" | "teachers">[];
  /** Gruppen mit Art und Jahrgang (Klassen zählen für die Stundentafel) */
  groups: { id: string; kind: string; gradeLevel: number | null }[];
  curriculum: ReadonlyMap<number, ReadonlyMap<string, number>>;
  teachers: CoverageTeacher[];
  teacherSubjects: ReadonlyMap<string, readonly string[]>;
}

export interface SubjectNeed {
  subjectId: string;
  name: string;
  color: string;
  /** Lehrerstunden aus Lehraufträgen (Teamteaching doppelt, Band einer Lehrkraft einmal) */
  assigned: number;
  /** Stunden, die Klassen laut Stundentafel noch fehlen (ohne Lehrauftrag) */
  missing: number;
  /** Bedarf = assigned + missing */
  demand: number;
  supply: number;
  balance: number;
  tone: NeedTone;
  teacherCount: number;
  advice: string[];
  /** nur mit Details (`stundenplan.manage`): Lehrkräfte mit dem Lehrfach und ihr Anteil an der Versorgung */
  teachers?: { id: string; code: string | null; name: string; hours: number }[];
}

/** Zwischenwerte für die Prognose */
export interface CoverageParts {
  /** Versorgung je Lehrkraft und Fach */
  supplyBy: Map<string, Map<string, number>>;
  /** Lehrerstunden je Fach in Gruppen, die keine Klasse sind (Kurse, AGs, WP, Förderkurse) – laufen ins nächste Jahr mit */
  nonClass: Map<string, number>;
  /** Stunden je Klasse und Fach (ohne Teamteaching-Faktor) */
  classHours: Map<string, Map<string, number>>;
}

function bump(m: Map<string, number>, k: string, v: number) {
  m.set(k, (m.get(k) ?? 0) + v);
}

/**
 * Rein: Bedarf und Versorgung je Fach.
 * - Bedarf: Lehrerstunden der Lehraufträge (ein Band zählt je Lehrkraft einmal, offene Lehraufträge mit ihren Stunden) plus das, was
 *   einer Klasse laut Stundentafel ohne Lehrauftrag fehlt.
 * - Versorgung: je Lehrkraft mit gepflegten Lehrfächern deren Lehraufträge in diesen Fächern (bei Überhang anteilig aufs Soll gekürzt)
 *   plus freies Soll gleichmäßig auf ihre Lehrfächer verteilt. Lehrkräfte ohne Lehrfach zählen nirgends.
 */
export function computeCoverage(input: CoverageInput, details: boolean): { rows: SubjectNeed[]; parts: CoverageParts } {
  const kind = new Map(input.groups.map((g) => [g.id, g]));
  const assignedBy = new Map<string, number>();
  const nonClass = new Map<string, number>();
  const classHours = new Map<string, Map<string, number>>();
  const teacherIn = new Map<string, Map<string, number>>();
  const teacherTotal = new Map<string, number>();
  const bandSeen = new Set<string>();
  for (const a of input.assignments) {
    let contribution = 0;
    if (!a.teachers.length) contribution = a.hours;
    for (const t of a.teachers) {
      if (a.bandId) {
        const k = `${a.bandId}|${t.id}`;
        if (bandSeen.has(k)) continue;
        bandSeen.add(k);
      }
      contribution += a.hours;
      if (!teacherIn.has(t.id)) teacherIn.set(t.id, new Map());
      bump(teacherIn.get(t.id)!, a.subjectId, a.hours);
      bump(teacherTotal, t.id, a.hours);
    }
    bump(assignedBy, a.subjectId, contribution);
    const g = a.groups[0] ? kind.get(a.groups[0].id) : undefined;
    if (g?.kind === "klasse") {
      if (!classHours.has(g.id)) classHours.set(g.id, new Map());
      bump(classHours.get(g.id)!, a.subjectId, a.hours);
    } else bump(nonClass, a.subjectId, contribution);
  }
  // Stundentafel: was einer Klasse ohne (ausreichenden) Lehrauftrag fehlt
  const missingBy = new Map<string, number>();
  for (const g of input.groups) {
    if (g.kind !== "klasse" || g.gradeLevel === null) continue;
    const tafel = input.curriculum.get(g.gradeLevel);
    if (!tafel) continue;
    for (const [s, h] of tafel) bump(missingBy, s, Math.max(0, h - (classHours.get(g.id)?.get(s) ?? 0)));
  }
  // Versorgung je Lehrkraft
  const supplyBy = new Map<string, Map<string, number>>();
  const holders = new Map<string, CoverageTeacher[]>();
  for (const t of input.teachers) {
    const subjectsOfT = input.teacherSubjects.get(t.id) ?? [];
    if (!subjectsOfT.length) continue;
    const inL = subjectsOfT.map((s) => teacherIn.get(t.id)?.get(s) ?? 0);
    const sumL = inL.reduce((x, y) => x + y, 0);
    const scale = sumL > t.target && sumL > 0 ? t.target / sumL : 1;
    const rest = Math.max(0, t.target - (teacherTotal.get(t.id) ?? 0));
    const m = new Map<string, number>();
    subjectsOfT.forEach((s, i) => {
      m.set(s, inL[i]! * scale + rest / subjectsOfT.length);
      holders.set(s, [...(holders.get(s) ?? []), t]);
    });
    supplyBy.set(t.id, m);
  }
  const rows: SubjectNeed[] = [];
  for (const s of input.subjects) {
    const assigned = round1(assignedBy.get(s.id) ?? 0);
    const missing = round1(missingBy.get(s.id) ?? 0);
    const demand = round1(assigned + missing);
    const hs = holders.get(s.id) ?? [];
    const supply = round1(hs.reduce((x, t) => x + (supplyBy.get(t.id)?.get(s.id) ?? 0), 0));
    if (demand <= 0 && !hs.length) continue;
    const row: SubjectNeed = {
      subjectId: s.id,
      name: s.name,
      color: s.color,
      assigned,
      missing,
      demand,
      supply,
      balance: round1(supply - demand),
      tone: needTone(demand, supply, hs.length),
      teacherCount: hs.length,
      advice: adviceFor(s.name, demand, supply, hs.length),
    };
    if (details)
      row.teachers = hs
        .map((t) => ({ id: t.id, code: t.code, name: t.name, hours: round1(supplyBy.get(t.id)?.get(s.id) ?? 0) }))
        .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, "de"));
    rows.push(row);
  }
  return { rows, parts: { supplyBy, nonClass, classHours } };
}

export interface StaffChange {
  id: string;
  kind: StaffChangeKind;
  teacherId: string | null;
  subjectIds: string[];
  effectiveOn: string;
  hours: number;
}

export interface GradeForecast {
  grade: number;
  /** Klassen im laufenden Schuljahr */
  current: number;
  /** Vorschlag „rücken auf“ (unterster Jahrgang: wie bisher) */
  suggested: number;
  /** eigene Angabe der Planung; `null` = Vorschlag */
  custom: number | null;
  /** gilt in der Prognose */
  next: number;
  /** Stunden je Klasse aus der Stundentafel (sonst: Mittel der Lehraufträge des Jahrgangs) */
  source: "stundentafel" | "lehrauftraege" | "keine";
}

export interface ForecastNeed {
  subjectId: string;
  name: string;
  color: string;
  demand: number;
  supply: number;
  balance: number;
  tone: NeedTone;
  teacherCount: number;
  /** wegfallende bzw. hinzukommende Versorgung (Summen, ohne Namen) */
  leaving: number;
  joining: number;
  advice: string[];
}

export interface ForecastInput extends CoverageInput {
  changes: StaffChange[];
  /** eigene Klassenzahlen je Jahrgang */
  customGrades: ReadonlyMap<number, number>;
  /** Abgänge/Zugänge bis zu diesem Tag zählen (Ende des nächsten Schuljahres) */
  untilYmd: string;
}

/** Rein: Klassenzahl je Jahrgang im nächsten Schuljahr – Klassen rücken auf, der unterste Jahrgang bleibt wie bisher. */
export function gradeForecast(input: Pick<ForecastInput, "groups" | "curriculum" | "customGrades">): GradeForecast[] {
  const count = new Map<number, number>();
  for (const g of input.groups) if (g.kind === "klasse" && g.gradeLevel !== null) count.set(g.gradeLevel, (count.get(g.gradeLevel) ?? 0) + 1);
  for (const grade of input.customGrades.keys()) if (!count.has(grade)) count.set(grade, 0);
  if (!count.size) return [];
  const grades = [...count.keys()].sort((a, b) => a - b);
  const min = grades[0]!;
  const max = grades.at(-1)!;
  const out: GradeForecast[] = [];
  for (let grade = min; grade <= max; grade++) {
    const current = count.get(grade) ?? 0;
    const suggested = grade === min ? current : (count.get(grade - 1) ?? 0);
    const custom = input.customGrades.get(grade) ?? null;
    const tafel = input.curriculum.get(grade);
    out.push({ grade, current, suggested, custom, next: custom ?? suggested, source: tafel && tafel.size ? "stundentafel" : current > 0 ? "lehrauftraege" : "keine" });
  }
  return out;
}

/**
 * Rein: Prognose fürs nächste Schuljahr. Bedarf = Klassen je Jahrgang × Stunden je Klasse (Stundentafel, sonst Mittel der Lehraufträge
 * des Jahrgangs) + Kurse/AGs wie bisher. Versorgung = heutige Versorgung je Lehrkraft, gekürzt um ihre Abgänge, plus Zugänge (Stunden
 * gleichmäßig auf ihre Fächer). Ohne Namen.
 */
export function computeForecast(input: ForecastInput, cov: { rows: SubjectNeed[]; parts: CoverageParts }): { rows: ForecastNeed[]; grades: GradeForecast[] } {
  const grades = gradeForecast(input);
  const { supplyBy, nonClass, classHours } = cov.parts;
  // Stunden je Klasse im Jahrgang
  const perClass = new Map<number, Map<string, number>>();
  for (const g of grades) {
    if (g.source === "stundentafel") perClass.set(g.grade, new Map(input.curriculum.get(g.grade)!));
    else if (g.source === "lehrauftraege") {
      const classes = input.groups.filter((x) => x.kind === "klasse" && x.gradeLevel === g.grade);
      const m = new Map<string, number>();
      for (const c of classes) for (const [s, h] of classHours.get(c.id) ?? []) bump(m, s, h / classes.length);
      perClass.set(g.grade, m);
    }
  }
  const demandBy = new Map(nonClass);
  for (const g of grades) for (const [s, h] of perClass.get(g.grade) ?? []) bump(demandBy, s, g.next * h);
  // Abgänge je Lehrkraft (bis Ende des nächsten Schuljahres), Zugänge je Fach
  const leavingHours = new Map<string, number>();
  const joiningBy = new Map<string, number>();
  const joiningCount = new Map<string, number>();
  for (const c of input.changes) {
    if (c.effectiveOn > input.untilYmd) continue;
    if (c.kind === "abgang" && c.teacherId) bump(leavingHours, c.teacherId, c.hours);
    if (c.kind === "zugang" && c.subjectIds.length) {
      for (const s of c.subjectIds) {
        bump(joiningBy, s, c.hours / c.subjectIds.length);
        bump(joiningCount, s, 1);
      }
    }
  }
  const supplyNext = new Map<string, number>();
  const leavingBy = new Map<string, number>();
  const gone = new Map<string, number>();
  for (const t of input.teachers) {
    const m = supplyBy.get(t.id);
    if (!m) continue;
    const left = leavingHours.get(t.id) ?? 0;
    const factor = t.target > 0 ? Math.max(0, t.target - left) / t.target : 0;
    for (const [s, h] of m) {
      bump(supplyNext, s, h * factor);
      bump(leavingBy, s, h * (1 - factor));
      if (factor === 0 && left > 0) bump(gone, s, 1);
    }
  }
  const currentCount = new Map(cov.rows.map((r) => [r.subjectId, r.teacherCount]));
  const rows: ForecastNeed[] = [];
  for (const s of input.subjects) {
    const demand = round1(demandBy.get(s.id) ?? 0);
    const supply = round1((supplyNext.get(s.id) ?? 0) + (joiningBy.get(s.id) ?? 0));
    const teacherCount = Math.max(0, (currentCount.get(s.id) ?? 0) - (gone.get(s.id) ?? 0)) + (joiningCount.get(s.id) ?? 0);
    if (demand <= 0 && teacherCount === 0 && !(leavingBy.get(s.id) ?? 0)) continue;
    rows.push({
      subjectId: s.id,
      name: s.name,
      color: s.color,
      demand,
      supply,
      balance: round1(supply - demand),
      tone: needTone(demand, supply, teacherCount),
      teacherCount,
      leaving: round1(leavingBy.get(s.id) ?? 0),
      joining: round1(joiningBy.get(s.id) ?? 0),
      advice: adviceFor(s.name, demand, supply, teacherCount),
    });
  }
  return { rows, grades };
}

// ---------------------------------------------------------------- Laden

/** Name des Folgejahres: „2026/27“ → „2027/28“, „2026/2027“ → „2027/2028“. */
export function nextYearName(name: string): string {
  const m = /^(\d{4})\/(\d{2}|\d{4})$/.exec(name.trim());
  if (!m) return "nächstes Schuljahr";
  const a = Number(m[1]) + 1;
  return m[2]!.length === 2 ? `${a}/${String((a + 1) % 100).padStart(2, "0")}` : `${a}/${a + 1}`;
}

const plusYear = (ymd: string) => `${Number(ymd.slice(0, 4)) + 1}${ymd.slice(4)}`;

export interface StaffChangeView extends StaffChange {
  teacherCode: string | null;
  teacherName: string | null;
}

export interface Fachbedarf {
  year: { id: string; name: string };
  refYmd: string;
  next: { name: string; startsOn: string; endsOn: string; exists: boolean };
  current: SubjectNeed[];
  forecast: ForecastNeed[];
  grades: GradeForecast[];
  /** Zahl der Lehrkräfte ohne gepflegte Lehrfächer */
  unmaintained: number;
  /** nur mit Details */
  teachersWithoutSubjects?: { id: string; code: string | null; name: string }[];
  changes?: StaffChangeView[];
}

/** Fachbedarf des Planungsjahres; `details` nur mit `stundenplan.manage` (Namen, Abgänge), sonst nur Summen je Fach. */
export async function loadFachbedarf(db: Db, todayYmd: string, { details }: { details: boolean }): Promise<Fachbedarf | null> {
  const year = await planningYear(db);
  if (!year) return null;
  const [d, school, subjectRows, map, changeRows, gradeRows, [nextRow]] = await Promise.all([
    distribution(db, year, todayYmd),
    readSchoolSettings(db),
    db.select({ id: subjects.id, name: subjects.name, color: subjects.color }).from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.id)),
    teacherSubjectMap(db),
    db
      .select({ c: timetableStaffChanges, code: users.shortCode, name: users.name })
      .from(timetableStaffChanges)
      .leftJoin(users, eq(users.id, timetableStaffChanges.teacherId))
      .orderBy(asc(timetableStaffChanges.effectiveOn), asc(timetableStaffChanges.createdAt)),
    db.select().from(timetableForecastGrades).where(eq(timetableForecastGrades.schoolYearId, year.id)),
    db.select().from(schoolYears).where(gt(schoolYears.startsOn, year.endsOn)).orderBy(asc(schoolYears.startsOn)).limit(1),
  ]);
  const accounts = await deputyAccounts(db, year.id, d.teachers, defaultObligation(school.profile.form));
  const next = nextRow
    ? { name: nextRow.name, startsOn: nextRow.startsOn, endsOn: nextRow.endsOn, exists: true }
    : { name: nextYearName(year.name), startsOn: plusYear(year.startsOn), endsOn: plusYear(year.endsOn), exists: false };
  const changes: StaffChangeView[] = changeRows.map(({ c, code, name }) => ({
    id: c.id,
    kind: c.kind,
    teacherId: c.teacherId,
    subjectIds: c.subjectIds,
    effectiveOn: c.effectiveOn,
    hours: c.hours,
    teacherCode: code,
    teacherName: name,
  }));
  const input: ForecastInput = {
    subjects: subjectRows,
    assignments: d.assignments,
    groups: d.groups,
    curriculum: d.curriculum,
    teachers: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, target: a.target })),
    teacherSubjects: map,
    changes,
    customGrades: new Map(gradeRows.map((g) => [g.grade, g.classes])),
    untilYmd: next.endsOn,
  };
  const cov = computeCoverage(input, details);
  const fc = computeForecast(input, cov);
  const without = accounts.filter((a) => !map.get(a.id)?.length);
  const out: Fachbedarf = { year: { id: year.id, name: year.name }, refYmd: d.refYmd, next, current: cov.rows, forecast: fc.rows, grades: fc.grades, unmaintained: without.length };
  if (details) {
    out.teachersWithoutSubjects = without.map((a) => ({ id: a.id, code: a.code, name: a.name }));
    out.changes = changes;
  }
  return out;
}

// ---------------------------------------------------------------- Pflege (nur `stundenplan.manage`)

export interface StaffChangeInput {
  kind: string;
  teacherId: string | null;
  subjectIds: string[];
  effectiveOn: string;
  hours: number;
}

/** Abgang (Lehrkraft) bzw. Zugang (Fächer) eintragen – Datum + Stunden, ohne Begründung. */
export async function addStaffChange(db: Db, actorId: string, input: StaffChangeInput): Promise<string> {
  const fe: Record<string, string> = {};
  const kind = input.kind === "abgang" || input.kind === "zugang" ? input.kind : null;
  if (!kind) fe.kind = "Abgang oder Zugang wählen";
  if (!isCalendarDate(input.effectiveOn)) fe.effectiveOn = "Datum angeben";
  if (!Number.isFinite(input.hours) || !Number.isInteger(input.hours * 2) || input.hours <= 0 || input.hours > 40) fe.hours = "0,5 bis 40 Stunden in halben Schritten";
  const subjectIds = [...new Set(input.subjectIds.filter(Boolean))];
  if (kind === "abgang") {
    const [t] = input.teacherId ? await db.select({ role: users.role }).from(users).where(eq(users.id, input.teacherId)) : [];
    if (t?.role !== "lehrkraft") fe.teacherId = "Lehrkraft wählen";
  }
  if (kind === "zugang") {
    if (!subjectIds.length) fe.subjectIds = "mindestens ein Fach wählen";
    else {
      const known = await db.select({ id: subjects.id }).from(subjects);
      if (subjectIds.some((s) => !known.some((k) => k.id === s))) fe.subjectIds = "Fach gibt es nicht";
    }
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db
    .insert(timetableStaffChanges)
    .values({
      kind: kind!,
      teacherId: kind === "abgang" ? input.teacherId : null,
      subjectIds: kind === "zugang" ? subjectIds : [],
      effectiveOn: input.effectiveOn,
      hours: input.hours,
      createdBy: actorId,
    })
    .returning({ id: timetableStaffChanges.id });
  await audit(db, actorId, "stundenplan.staff_change.add", kind === "abgang" ? input.teacherId : null, { kind, effectiveOn: input.effectiveOn, hours: input.hours });
  return row!.id;
}

export async function deleteStaffChange(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableStaffChanges).where(eq(timetableStaffChanges.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.staff_change.delete", old.teacherId, { kind: old.kind, effectiveOn: old.effectiveOn });
}

/** Klassenzahl je Jahrgang fürs nächste Schuljahr; `null` = Vorschlag „rücken auf“. */
export async function saveForecastGrades(db: Db, actorId: string, schoolYearId: string, entries: { grade: number; classes: number | null }[]): Promise<void> {
  const fe: Record<string, string> = {};
  for (const e of entries) {
    if (!Number.isInteger(e.grade) || e.grade < 1 || e.grade > 13) fe[`g${e.grade}`] = "Jahrgang 1 bis 13";
    else if (e.classes !== null && (!Number.isInteger(e.classes) || e.classes < 0 || e.classes > 30)) fe[`g${e.grade}`] = "0 bis 30 Klassen";
  }
  const [y] = await db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, schoolYearId));
  if (!y) fe.schoolYearId = "Schuljahr gibt es nicht";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db.transaction(async (tx) => {
    for (const e of entries) {
      const where = and(eq(timetableForecastGrades.schoolYearId, schoolYearId), eq(timetableForecastGrades.grade, e.grade));
      if (e.classes === null) await tx.delete(timetableForecastGrades).where(where);
      else
        await tx
          .insert(timetableForecastGrades)
          .values({ schoolYearId, grade: e.grade, classes: e.classes })
          .onConflictDoUpdate({ target: [timetableForecastGrades.schoolYearId, timetableForecastGrades.grade], set: { classes: e.classes } });
    }
  });
  await audit(db, actorId, "stundenplan.forecast.grades", null, { grades: entries.length });
}
