// Unterrichtsverteilung (P2b-08): Lehraufträge je Schuljahr und Abgleich Soll ↔ verplant im Stundenplan.
// SP2-01: Bänder bündeln Lehraufträge, die zur selben Zeit liegen; jeder Lehrauftrag hat genau eine Gruppe.
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import {
  curriculumHours,
  groups,
  rooms,
  schoolYears,
  subjects,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableBands,
  timetableLessons,
  users,
} from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { isCalendarDate } from "@/core/time";
import { de } from "@/core/db/sort";

/** Gruppenarten, für die Unterricht verteilt wird */
export const PLANNED_GROUP_KINDS = ["klasse", "kurs", "ag", "wahlpflicht", "foerderkurs"] as const;

export interface AssignmentInput {
  schoolYearId: string;
  /** genau eine Klasse oder ein Kurs – was zur selben Zeit liegen soll, bündelt ein Band */
  groupId: string;
  subjectId: string;
  /** Wochen-/Doppelstunden; im Band gelten die des Bands */
  hours: number;
  /** höchstens zwei (Teamteaching), leer = noch offen */
  teacherIds: string[];
  doubleLessons: number;
  roomId: string | null;
  note: string | null;
  /** SP2-01: Band (leer = eigenständig); fehlt das Feld, bleibt das bisherige Band */
  bandId?: string | null;
  /** SP2-09: gültig ab/bis (YYYY-MM-DD, im Schuljahr); leer = ganzes Schuljahr */
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface Assignment {
  id: string;
  subjectId: string;
  subjectName: string;
  color: string;
  hours: number;
  doubleLessons: number;
  roomId: string | null;
  note: string | null;
  /** SP2-01: Band des Lehrauftrags */
  bandId: string | null;
  /** genau eine Gruppe (vor SP2-01: Kopplung mit mehreren) */
  groups: { id: string; name: string }[];
  teachers: { id: string; code: string | null; name: string }[];
  /** SP2-09: gültig ab/bis; `null` = Beginn bzw. Ende des Schuljahrs */
  validFrom: string | null;
  validUntil: string | null;
}

/** SP2-09: gilt der Lehrauftrag am Tag `ymd`? (ohne Angaben: das ganze Schuljahr) */
export function activeOn(a: Pick<Assignment, "validFrom" | "validUntil">, ymd: string): boolean {
  return (a.validFrom === null || a.validFrom <= ymd) && (a.validUntil === null || a.validUntil >= ymd);
}

/** SP2-09: überschneiden sich die Gültigkeiten zweier Lehraufträge? */
export function validityOverlaps(a: Pick<Assignment, "validFrom" | "validUntil">, b: Pick<Assignment, "validFrom" | "validUntil">): boolean {
  return (a.validFrom === null || b.validUntil === null || a.validFrom <= b.validUntil) && (b.validFrom === null || a.validUntil === null || b.validFrom <= a.validUntil);
}

/** SP2-01: Band mit Soll/verplant. */
export interface Band {
  id: string;
  name: string;
  hours: number;
  doubleLessons: number;
  /** Lehraufträge im Band (Reihenfolge wie in der Verteilung) */
  memberIds: string[];
}

export interface BandStatus extends Band {
  /** verplante Wochenstunden: das am wenigsten verplante Mitglied */
  planned: number;
  /** davon zur selben Zeit (alle Mitglieder im selben Slot) – Kennzahl der Diagnose (SP2-02) */
  together: number;
  /** alle Mitglieder mit gleichem Fach, gleichen Lehrkräften und gleichem Raumwunsch (die frühere Kopplung „eine Lehrkraft, mehrere Gruppen“) */
  uniform: boolean;
}

/** Schuljahr, für das verteilt wird: das aktuelle, sonst das jüngste. */
export async function planningYear(db: Db) {
  const rows = await db.select().from(schoolYears).orderBy(asc(schoolYears.startsOn));
  return rows.find((y) => y.isCurrent) ?? rows.at(-1) ?? null;
}

/** Stichtag für „verplant“: heute, eingegrenzt auf das Schuljahr. */
export function referenceDate(year: { startsOn: string; endsOn: string }, todayYmd: string): string {
  if (todayYmd < year.startsOn) return year.startsOn;
  if (todayYmd > year.endsOn) return year.endsOn;
  return todayYmd;
}

export async function listAssignments(db: Db, schoolYearId: string): Promise<Assignment[]> {
  const rows = await db
    .select({ a: timetableAssignments, subjectName: subjects.name, color: subjects.color })
    .from(timetableAssignments)
    .innerJoin(subjects, eq(subjects.id, timetableAssignments.subjectId))
    .where(eq(timetableAssignments.schoolYearId, schoolYearId))
    // deterministisch auch bei gleichem Fach und Anlagezeitpunkt (Seed, Import): zuletzt nach id – die Reihenfolge bestimmt den Solver-Lauf;
    // Fachname und id bytegenau (collate "C"), sonst sortieren PGlite und PostgreSQL mit anderer Collation verschieden (R1a/A15)
    .orderBy(asc(subjects.sortOrder), sql`${subjects.name} collate "C"`, asc(timetableAssignments.createdAt), sql`${timetableAssignments.id} collate "C"`);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.a.id);
  const [gs, ts] = await Promise.all([
    db
      .select({ aid: timetableAssignmentGroups.assignmentId, id: groups.id, name: groups.name })
      .from(timetableAssignmentGroups)
      .innerJoin(groups, eq(groups.id, timetableAssignmentGroups.groupId))
      .where(inArray(timetableAssignmentGroups.assignmentId, ids))
      .orderBy(asc(groups.gradeLevel), de(groups.name)),
    db
      .select({ aid: timetableAssignmentTeachers.assignmentId, id: users.id, code: users.shortCode, name: users.name })
      .from(timetableAssignmentTeachers)
      .innerJoin(users, eq(users.id, timetableAssignmentTeachers.teacherId))
      .where(inArray(timetableAssignmentTeachers.assignmentId, ids))
      .orderBy(asc(users.shortCode)),
  ]);
  return rows.map(({ a, subjectName, color }) => ({
    id: a.id,
    subjectId: a.subjectId,
    subjectName,
    color,
    hours: a.hours,
    doubleLessons: a.doubleLessons,
    roomId: a.roomId,
    note: a.note,
    bandId: a.bandId,
    validFrom: a.validFrom,
    validUntil: a.validUntil,
    groups: gs.filter((g) => g.aid === a.id).map(({ id, name }) => ({ id, name })),
    teachers: ts.filter((t) => t.aid === a.id).map(({ id, code, name }) => ({ id, code, name })),
  }));
}

// ---------------------------------------------------------------- Abgleich

/** Eine Stunde des Stundenplans, wie sie in die Wochenstunden eingeht. */
export interface PlanLesson {
  id: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  /** 1 = jede Woche, 0,5 = nur A- oder B-Woche */
  weight: number;
  /** Slot (SP2-01: „gemeinsam verplant“ im Band, Lehrkraft-Stunden einmal je Slot); fehlt in reinen Tests */
  weekday?: number;
  periodNr?: number;
  week?: string;
}

/** Schlüssel des Slots einer Stunde (Wochentag, Stunde, Woche); ohne Slot die Stunde selbst. */
const slotKey = (l: PlanLesson) => (l.weekday === undefined ? `#${l.id}` : `${l.weekday}|${l.periodNr}|${l.week ?? "all"}`);

export interface AssignmentStatus {
  /** verplante Wochenstunden (bei Kopplung: die am wenigsten verplante Gruppe) */
  planned: number;
  /** mindestens eine Stunde liegt bei einer anderen Lehrkraft als im Auftrag */
  otherTeacher: boolean;
}

export interface MatchResult {
  byAssignment: Map<string, AssignmentStatus>;
  /** Stunden ohne passenden Lehrauftrag */
  unmatched: PlanLesson[];
  /** SP2-01: Lehrauftrag je zugeordneter Stunde */
  assignmentOf: Map<string, string>;
}

type MatchAssignment = Pick<Assignment, "id" | "subjectId" | "hours"> & { groupIds: string[]; teacherIds: string[] };

/**
 * Ordnet jede Stunde höchstens einem Lehrauftrag zu: gleiches Fach und Gruppe, bevorzugt mit passender
 * Lehrkraft und solange der Auftrag in dieser Gruppe noch offen ist.
 */
export function matchLessons(assignments: MatchAssignment[], lessons: PlanLesson[]): MatchResult {
  const perGroup = new Map<string, number>();
  const other = new Set<string>();
  const unmatched: PlanLesson[] = [];
  const assignmentOf = new Map<string, string>();
  const key = (aid: string, gid: string) => `${aid}|${gid}`;
  for (const l of lessons) {
    const candidates = assignments.filter((a) => a.subjectId === l.subjectId && a.groupIds.includes(l.groupId));
    if (!candidates.length) {
      unmatched.push(l);
      continue;
    }
    const teacherFits = (a: MatchAssignment) => !l.teacherId || a.teacherIds.length === 0 || a.teacherIds.includes(l.teacherId);
    const open = (a: MatchAssignment) => (perGroup.get(key(a.id, l.groupId)) ?? 0) < a.hours;
    const pick =
      candidates.find((a) => teacherFits(a) && open(a)) ??
      candidates.find((a) => teacherFits(a)) ??
      candidates.find(open) ??
      candidates[0]!;
    if (!teacherFits(pick)) other.add(pick.id);
    assignmentOf.set(l.id, pick.id);
    perGroup.set(key(pick.id, l.groupId), (perGroup.get(key(pick.id, l.groupId)) ?? 0) + l.weight);
  }
  const byAssignment = new Map<string, AssignmentStatus>();
  for (const a of assignments) {
    const planned = a.groupIds.length ? Math.min(...a.groupIds.map((g) => perGroup.get(key(a.id, g)) ?? 0)) : 0;
    byAssignment.set(a.id, { planned, otherTeacher: other.has(a.id) });
  }
  return { byAssignment, unmatched, assignmentOf };
}

/**
 * Rein (SP2-01): Soll/verplant je Band. `planned` = am wenigsten verplantes Mitglied, `together` = Wochenstunden, in denen alle
 * Mitglieder im selben Slot liegen (Solver und Setzhilfe setzen ein Band seit SP2-02 immer gemeinsam – weniger heißt: von Hand
 * auseinandergezogen oder vor SP2-02 geplant). `uniform` = frühere Kopplung (gleiches Fach, gleiche Lehrkräfte, gleicher Raumwunsch).
 */
export function bandStatus(
  bands: Band[],
  assignments: (Pick<Assignment, "id" | "subjectId" | "roomId" | "teachers"> & { planned: number })[],
  lessons: PlanLesson[],
  assignmentOf: Map<string, string>,
): BandStatus[] {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const slotsOf = new Map<string, Map<string, number>>();
  for (const l of lessons) {
    const aid = assignmentOf.get(l.id);
    if (!aid) continue;
    const m = slotsOf.get(aid) ?? new Map<string, number>();
    m.set(slotKey(l), l.weight);
    slotsOf.set(aid, m);
  }
  return bands.map((b) => {
    const members = b.memberIds.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
    const planned = members.length ? Math.min(...members.map((a) => a.planned)) : 0;
    let together = 0;
    if (members.length) {
      const [first, ...rest] = members.map((a) => slotsOf.get(a.id) ?? new Map<string, number>());
      for (const [k, w] of first!) if (rest.every((m) => m.has(k))) together += w;
    }
    const teacherKey = (a: (typeof members)[number]) => a.teachers.map((t) => t.id).sort().join(",");
    const uniform = members.every((a) => a.subjectId === members[0]!.subjectId && a.roomId === members[0]!.roomId && teacherKey(a) === teacherKey(members[0]!));
    return { ...b, planned, together: Math.min(together, planned), uniform };
  });
}

/** Stunden, die am Stichtag gelten (unabhängig vom Wochentag), mit Gewicht nach A/B-Woche. */
export async function planLessonsOn(db: Db, refYmd: string): Promise<PlanLesson[]> {
  const rows = await db
    .select({
      id: timetableLessons.id,
      groupId: timetableLessons.groupId,
      subjectId: timetableLessons.subjectId,
      teacherId: timetableLessons.teacherId,
      week: timetableLessons.week,
      weekday: timetableLessons.weekday,
      periodNr: timetableLessons.periodNr,
    })
    .from(timetableLessons)
    .where(and(lte(timetableLessons.validFrom, refYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, refYmd))))
    .orderBy(asc(timetableLessons.weekday), asc(timetableLessons.periodNr));
  return rows.map((r) => ({ ...r, weight: r.week === "all" ? 1 : 0.5 }));
}

/** SP2-01: Bänder eines Schuljahres mit ihren Mitgliedern (Reihenfolge der Mitglieder wie `assignments`). */
export async function listBands(db: Db, schoolYearId: string, assignments?: Pick<Assignment, "id" | "bandId">[]): Promise<Band[]> {
  const [rows, list] = await Promise.all([
    db.select().from(timetableBands).where(eq(timetableBands.schoolYearId, schoolYearId)).orderBy(de(timetableBands.name)),
    assignments ? Promise.resolve(assignments) : listAssignments(db, schoolYearId),
  ]);
  return rows.map((b) => ({ id: b.id, name: b.name, hours: b.hours, doubleLessons: b.doubleLessons, memberIds: list.filter((a) => a.bandId === b.id).map((a) => a.id) }));
}

export interface GroupTotals {
  id: string;
  name: string;
  kind: string;
  gradeLevel: number | null;
  homeRoomId: string | null;
  /** Summe der Stundentafel des Jahrgangs (nur Klassen) */
  curriculum: number | null;
  assigned: number;
  planned: number;
}

export interface TeacherTotals {
  id: string;
  code: string | null;
  name: string;
  assigned: number;
  planned: number;
}

export interface Distribution {
  refYmd: string;
  assignments: (Assignment & AssignmentStatus)[];
  /** SP2-09: Lehraufträge des Schuljahrs, die am Stichtag nicht gelten (zählen nirgends mit) */
  otherTime: Assignment[];
  /** SP2-01: Bänder mit Soll/verplant */
  bands: BandStatus[];
  groups: GroupTotals[];
  teachers: TeacherTotals[];
  unmatched: (PlanLesson & { groupName: string; subjectName: string; teacherCode: string | null })[];
  /** Stundentafel je Jahrgang und Fach */
  curriculum: Map<number, Map<string, number>>;
  subjectNames: Map<string, string>;
}

/**
 * Rein (SP2-01): Wochenstunden der Lehraufträge einer Lehrkraft – ein Band zählt einmal, auch wenn sie darin mehrere Gruppen
 * unterrichtet (frühere Kopplung „eine Lehrkraft, zwei Klassen“).
 */
export function teacherAssigned(list: Pick<Assignment, "hours" | "bandId" | "teachers">[], teacherId: string): number {
  const bands = new Set<string>();
  let total = 0;
  for (const a of list) {
    if (!a.teachers.some((x) => x.id === teacherId)) continue;
    if (a.bandId) {
      if (bands.has(a.bandId)) continue;
      bands.add(a.bandId);
    }
    total += a.hours;
  }
  return total;
}

/** Rein (SP2-01): verplante Wochenstunden einer Lehrkraft – gekoppelte Gruppen im selben Slot zählen einmal. */
export function teacherPlanned(lessons: PlanLesson[], teacherId: string): number {
  const slots = new Map<string, number>();
  for (const l of lessons) if (l.teacherId === teacherId) slots.set(slotKey(l), l.weight);
  return [...slots.values()].reduce((s, w) => s + w, 0);
}

/** Komplette Unterrichtsverteilung eines Schuljahres mit Soll/verplant je Auftrag, Gruppe und Lehrkraft. */
export async function distribution(db: Db, year: { id: string; startsOn: string; endsOn: string }, todayYmd: string): Promise<Distribution> {
  const refYmd = referenceDate(year, todayYmd);
  const [all, lessons, groupRows, teacherRows, tafel, subjectRows] = await Promise.all([
    listAssignments(db, year.id),
    planLessonsOn(db, refYmd),
    db
      .select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel, homeRoomId: groups.homeRoomId, schoolYearId: groups.schoolYearId })
      .from(groups)
      .where(inArray(groups.kind, [...PLANNED_GROUP_KINDS]))
      .orderBy(asc(groups.kind), asc(groups.gradeLevel), de(groups.name)),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")).orderBy(asc(users.shortCode)),
    db.select().from(curriculumHours),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
  ]);
  // SP2-09: Verteilung am Stichtag – Lehraufträge, die dann nicht gelten, stehen gesondert (`otherTime`)
  const list = all.filter((a) => activeOn(a, refYmd));
  const { byAssignment, unmatched, assignmentOf } = matchLessons(
    list.map((a) => ({ id: a.id, subjectId: a.subjectId, hours: a.hours, groupIds: a.groups.map((g) => g.id), teacherIds: a.teachers.map((t) => t.id) })),
    lessons,
  );
  const withStatus = list.map((a) => ({ ...a, ...byAssignment.get(a.id)! }));
  const bandRows = await listBands(db, year.id, list);
  const bands = bandStatus(bandRows, withStatus, lessons, assignmentOf);
  const curriculum = new Map<number, Map<string, number>>();
  for (const c of tafel) {
    if (!curriculum.has(c.gradeLevel)) curriculum.set(c.gradeLevel, new Map());
    curriculum.get(c.gradeLevel)!.set(c.subjectId, c.hours);
  }
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const groupsOut: GroupTotals[] = groupRows
    .filter((g) => g.schoolYearId === year.id || g.schoolYearId === null)
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      gradeLevel: g.gradeLevel,
      homeRoomId: g.homeRoomId,
      curriculum: g.kind === "klasse" && g.gradeLevel !== null && curriculum.has(g.gradeLevel) ? sum([...curriculum.get(g.gradeLevel)!.values()]) : null,
      assigned: sum(list.filter((a) => a.groups.some((x) => x.id === g.id)).map((a) => a.hours)),
      planned: sum(lessons.filter((l) => l.groupId === g.id).map((l) => l.weight)),
    }));
  const teachersOut: TeacherTotals[] = teacherRows.map((t) => ({
    ...t,
    assigned: teacherAssigned(list, t.id),
    planned: teacherPlanned(lessons, t.id),
  }));
  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));
  const subjectName = new Map(subjectRows.map((s) => [s.id, s.name]));
  const teacherCode = new Map(teacherRows.map((t) => [t.id, t.code]));
  return {
    refYmd,
    assignments: withStatus,
    otherTime: all.filter((a) => !activeOn(a, refYmd)),
    bands,
    groups: groupsOut,
    teachers: teachersOut,
    unmatched: unmatched.map((l) => ({
      ...l,
      groupName: groupName.get(l.groupId) ?? l.groupId,
      subjectName: subjectName.get(l.subjectId) ?? l.subjectId,
      teacherCode: l.teacherId ? (teacherCode.get(l.teacherId) ?? null) : null,
    })),
    curriculum,
    subjectNames: subjectName,
  };
}

// ---------------------------------------------------------------- Pflege

/** Band eines Lehrauftrags: Wochen-/Doppelstunden kommen vom Band. */
async function bandOf(db: Db, bandId: string) {
  const [b] = await db.select().from(timetableBands).where(eq(timetableBands.id, bandId));
  return b ?? null;
}

type EffectiveInput = AssignmentInput & { bandId: string | null };

/** Eingabe mit den Stunden des Bands (falls im Band); ohne `bandId` im Input bleibt das bisherige Band. */
async function effective(db: Db, input: AssignmentInput, currentBandId: string | null): Promise<EffectiveInput> {
  const bandId = input.bandId === undefined ? currentBandId : input.bandId || null;
  const band = bandId ? await bandOf(db, bandId) : null;
  if (bandId && (!band || band.schoolYearId !== input.schoolYearId)) throw new ValidationError({ bandId: "Band gibt es nicht (mehr)" });
  return band ? { ...input, bandId, hours: band.hours, doubleLessons: band.doubleLessons } : { ...input, bandId: null };
}

async function validate(db: Db, input: AssignmentInput, excludeId?: string): Promise<void> {
  const fe: Record<string, string> = {};
  const teacherIds = [...new Set(input.teacherIds)];
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 12) fe.hours = "1 bis 12 Wochenstunden";
  else if (!Number.isInteger(input.doubleLessons) || input.doubleLessons < 0 || input.doubleLessons * 2 > input.hours)
    fe.doubleLessons = `höchstens ${Math.floor(input.hours / 2)} Doppelstunden bei ${input.hours} Wochenstunden`;
  if (input.note && input.note.length > 200) fe.note = "höchstens 200 Zeichen";
  const validFrom = input.validFrom || null;
  const validUntil = input.validUntil || null;
  const isDate = (v: string | null) => v === null || isCalendarDate(v);
  if (!isDate(validFrom)) fe.validFrom = "Datum angeben";
  if (!isDate(validUntil)) fe.validUntil = "Datum angeben";
  if (!fe.validFrom && !fe.validUntil && validFrom && validUntil && validFrom > validUntil) fe.validUntil = "„gültig bis“ liegt vor „gültig ab“";
  if (teacherIds.length > 2) fe.teacherIds = "höchstens zwei Lehrkräfte (Teamteaching) – weitere Gruppen über ein Band";
  const [[y], [s], gs, ts, r] = await Promise.all([
    db.select({ id: schoolYears.id, startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.id, input.schoolYearId)),
    db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, input.subjectId)),
    input.groupId ? db.select({ id: groups.id, kind: groups.kind }).from(groups).where(eq(groups.id, input.groupId)) : Promise.resolve([]),
    teacherIds.length ? db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, teacherIds)) : Promise.resolve([]),
    input.roomId ? db.select({ id: rooms.id, active: rooms.active }).from(rooms).where(eq(rooms.id, input.roomId)) : Promise.resolve([{ id: "", active: true }]),
  ]);
  if (!y) fe.schoolYearId = "Schuljahr gibt es nicht";
  else {
    const inYear = (v: string | null) => v === null || (v >= y.startsOn && v <= y.endsOn);
    if (!fe.validFrom && !inYear(validFrom)) fe.validFrom = "muss im Schuljahr liegen";
    if (!fe.validUntil && !inYear(validUntil)) fe.validUntil = "muss im Schuljahr liegen";
  }
  if (!s) fe.subjectId = "Fach wählen";
  if (!input.groupId) fe.groupId = "Eine Klasse oder einen Kurs wählen";
  else if (!gs[0] || !(PLANNED_GROUP_KINDS as readonly string[]).includes(gs[0].kind)) fe.groupId = "Gruppe ist keine Klasse und kein Kurs";
  if (!fe.teacherIds && (ts.length !== teacherIds.length || ts.some((t) => t.role !== "lehrkraft"))) fe.teacherIds = "Lehrkraft wählen";
  if (!r[0]?.active) fe.roomId = "Raum gibt es nicht oder ist inaktiv";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  // Doppelt erfasst? Gleiches Fach in derselben Gruppe bei einer der Lehrkräfte (bzw. beide ohne Lehrkraft) – SP2-09: nur bei sich
  // überschneidender Gültigkeit (Physik im 1., Physik bei derselben Lehrkraft im 2. Halbjahr darf getrennt stehen)
  const others = (await listAssignments(db, input.schoolYearId)).filter(
    (a) => a.id !== excludeId && a.subjectId === input.subjectId && validityOverlaps(a, { validFrom, validUntil }),
  );
  for (const o of others) {
    const sharedGroup = o.groups.find((g) => g.id === input.groupId);
    if (!sharedGroup) continue;
    const oTeachers = o.teachers.map((t) => t.id);
    const sameTeacher = teacherIds.length === 0 && oTeachers.length === 0 ? true : o.teachers.find((t) => teacherIds.includes(t.id));
    if (sameTeacher) {
      const who = typeof sameTeacher === "object" ? ` bei ${sameTeacher.code ?? sameTeacher.name}` : " ohne Lehrkraft";
      throw new ValidationError({ subjectId: `${sharedGroup.name} hat schon einen Lehrauftrag ${o.subjectName}${who} – dort die Stunden ändern` });
    }
  }
}

async function writeLinks(db: Db, id: string, input: AssignmentInput) {
  await db.delete(timetableAssignmentGroups).where(eq(timetableAssignmentGroups.assignmentId, id));
  await db.delete(timetableAssignmentTeachers).where(eq(timetableAssignmentTeachers.assignmentId, id));
  await db.insert(timetableAssignmentGroups).values({ assignmentId: id, groupId: input.groupId });
  const teacherIds = [...new Set(input.teacherIds)];
  if (teacherIds.length) await db.insert(timetableAssignmentTeachers).values(teacherIds.map((teacherId) => ({ assignmentId: id, teacherId })));
}

const values = (i: EffectiveInput) => ({
  schoolYearId: i.schoolYearId,
  subjectId: i.subjectId,
  hours: i.hours,
  doubleLessons: i.doubleLessons,
  roomId: i.roomId,
  note: i.note?.trim() || null,
  bandId: i.bandId,
  validFrom: i.validFrom || null,
  validUntil: i.validUntil || null,
});

export async function createAssignment(db: Db, actorId: string, raw: AssignmentInput): Promise<string> {
  const input = await effective(db, raw, null);
  await validate(db, input);
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(timetableAssignments).values(values(input)).returning({ id: timetableAssignments.id });
    await writeLinks(tx, row!.id, input);
    return row!.id;
  });
  await audit(db, actorId, "stundenplan.assignment.create", input.groupId, { subject: input.subjectId, hours: input.hours, band: input.bandId });
  return id;
}

export async function updateAssignment(db: Db, actorId: string, id: string, raw: AssignmentInput): Promise<void> {
  const [old] = await db.select({ id: timetableAssignments.id, bandId: timetableAssignments.bandId }).from(timetableAssignments).where(eq(timetableAssignments.id, id));
  if (!old) throw new ValidationError({ id: "Lehrauftrag gibt es nicht mehr" });
  const input = await effective(db, raw, old.bandId);
  await validate(db, input, id);
  await db.transaction(async (tx) => {
    await tx.update(timetableAssignments).set(values(input)).where(eq(timetableAssignments.id, id));
    await writeLinks(tx, id, input);
  });
  await audit(db, actorId, "stundenplan.assignment.update", input.groupId, { assignment: id, subject: input.subjectId, hours: input.hours, band: input.bandId });
}

export async function deleteAssignment(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableAssignments).where(eq(timetableAssignments.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.assignment.delete", null, { subject: old.subjectId, hours: old.hours });
}

// ---------------------------------------------------------------- Bänder (SP2-01)

export interface BandInput {
  schoolYearId: string;
  name: string;
  hours: number;
  doubleLessons: number;
}

async function validateBand(db: Db, input: BandInput, excludeId?: string): Promise<void> {
  const fe: Record<string, string> = {};
  const name = input.name.trim();
  if (!name) fe.name = "Namen angeben, z. B. „Religion/Philosophie 7“";
  else if (name.length > 60) fe.name = "höchstens 60 Zeichen";
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 12) fe.hours = "1 bis 12 Wochenstunden";
  else if (!Number.isInteger(input.doubleLessons) || input.doubleLessons < 0 || input.doubleLessons * 2 > input.hours)
    fe.doubleLessons = `höchstens ${Math.floor(input.hours / 2)} Doppelstunden bei ${input.hours} Wochenstunden`;
  const [y] = await db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, input.schoolYearId));
  if (!y) fe.schoolYearId = "Schuljahr gibt es nicht";
  if (!fe.name) {
    const same = await db
      .select({ id: timetableBands.id })
      .from(timetableBands)
      .where(and(eq(timetableBands.schoolYearId, input.schoolYearId), eq(timetableBands.name, name), excludeId ? ne(timetableBands.id, excludeId) : undefined));
    if (same.length) fe.name = "Ein Band mit diesem Namen gibt es schon";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
}

export async function createBand(db: Db, actorId: string, input: BandInput): Promise<string> {
  await validateBand(db, input);
  const [row] = await db
    .insert(timetableBands)
    .values({ schoolYearId: input.schoolYearId, name: input.name.trim(), hours: input.hours, doubleLessons: input.doubleLessons })
    .returning({ id: timetableBands.id });
  await audit(db, actorId, "stundenplan.band.create", null, { band: row!.id, hours: input.hours });
  return row!.id;
}

/** Ändert Name/Stunden; Wochen- und Doppelstunden gehen an alle Mitglieder. */
export async function updateBand(db: Db, actorId: string, id: string, input: BandInput): Promise<void> {
  const old = await bandOf(db, id);
  if (!old) throw new ValidationError({ id: "Band gibt es nicht mehr" });
  await validateBand(db, { ...input, schoolYearId: old.schoolYearId }, id);
  await db.transaction(async (tx) => {
    await tx.update(timetableBands).set({ name: input.name.trim(), hours: input.hours, doubleLessons: input.doubleLessons }).where(eq(timetableBands.id, id));
    await tx.update(timetableAssignments).set({ hours: input.hours, doubleLessons: input.doubleLessons }).where(eq(timetableAssignments.bandId, id));
  });
  await audit(db, actorId, "stundenplan.band.update", null, { band: id, hours: input.hours });
}

/**
 * Löscht das Band; die Lehraufträge bleiben eigenständig mit ihren Stunden. `onlyEmpty` (Oberfläche, Review R3 N4): nur ohne
 * Mitglieder – auch keine aus anderen Zeiträumen.
 */
export async function deleteBand(db: Db, actorId: string, id: string, opts: { onlyEmpty?: boolean } = {}): Promise<void> {
  if (opts.onlyEmpty) {
    const members = await db.select({ id: timetableAssignments.id }).from(timetableAssignments).where(eq(timetableAssignments.bandId, id));
    if (members.length)
      throw new ValidationError({ id: `Im Band ${members.length === 1 ? "ist noch ein Lehrauftrag" : `sind noch ${members.length} Lehraufträge`} – erst herausnehmen.` });
  }
  const [old] = await db.delete(timetableBands).where(eq(timetableBands.id, id)).returning({ id: timetableBands.id });
  if (old) await audit(db, actorId, "stundenplan.band.delete", null, { band: id });
}

/** Nimmt einen Lehrauftrag ins Band auf (übernimmt die Stunden des Bands) bzw. mit `null` heraus (Stunden bleiben). */
export async function setBandMember(db: Db, actorId: string, assignmentId: string, bandId: string | null): Promise<void> {
  const [a] = await db
    .select({ id: timetableAssignments.id, schoolYearId: timetableAssignments.schoolYearId, bandId: timetableAssignments.bandId })
    .from(timetableAssignments)
    .where(eq(timetableAssignments.id, assignmentId));
  if (!a) throw new ValidationError({ assignmentId: "Lehrauftrag gibt es nicht mehr" });
  if (!bandId) {
    if (!a.bandId) return;
    await db.update(timetableAssignments).set({ bandId: null }).where(eq(timetableAssignments.id, assignmentId));
    await audit(db, actorId, "stundenplan.band.member", null, { band: a.bandId, assignment: assignmentId, removed: true });
    return;
  }
  const band = await bandOf(db, bandId);
  if (!band || band.schoolYearId !== a.schoolYearId) throw new ValidationError({ bandId: "Band gibt es nicht (mehr)" });
  await db.update(timetableAssignments).set({ bandId, hours: band.hours, doubleLessons: band.doubleLessons }).where(eq(timetableAssignments.id, assignmentId));
  await audit(db, actorId, "stundenplan.band.member", null, { band: bandId, assignment: assignmentId });
}

/**
 * Legt für alle Stunden ohne Lehrauftrag passende Aufträge an (je Gruppe × Fach × Lehrkraft) – zum Einstieg
 * mit einem bestehenden Stundenplan. Doppelstunden = Tage mit zwei direkt aufeinanderfolgenden Stunden.
 */
export async function assignmentsFromTimetable(db: Db, actorId: string | null, year: { id: string; startsOn: string; endsOn: string }, todayYmd: string): Promise<number> {
  const refYmd = referenceDate(year, todayYmd);
  const { unmatched } = await distribution(db, year, todayYmd);
  if (!unmatched.length) return 0;
  const ids = new Set(unmatched.map((l) => l.id));
  const slots = (await db
    .select({ id: timetableLessons.id, weekday: timetableLessons.weekday, periodNr: timetableLessons.periodNr })
    .from(timetableLessons)
    .where(and(lte(timetableLessons.validFrom, refYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, refYmd))))).filter((s) => ids.has(s.id));
  const slotOf = new Map(slots.map((s) => [s.id, s]));
  const buckets = new Map<string, PlanLesson[]>();
  for (const l of unmatched) {
    const k = `${l.groupId}|${l.subjectId}|${l.teacherId ?? ""}`;
    buckets.set(k, [...(buckets.get(k) ?? []), l]);
  }
  const rows = [...buckets.values()].map((ls) => {
    const hours = Math.min(12, Math.max(1, Math.ceil(ls.reduce((s, l) => s + l.weight, 0))));
    const byDay = new Map<number, number[]>();
    for (const l of ls) {
      const s = slotOf.get(l.id)!;
      byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s.periodNr]);
    }
    let doubles = 0;
    for (const ps of byDay.values()) {
      const sorted = [...new Set(ps)].sort((a, b) => a - b);
      for (let i = 0; i + 1 < sorted.length; i++) {
        if (sorted[i + 1] !== sorted[i]! + 1) continue;
        doubles++;
        i++;
      }
    }
    return { id: crypto.randomUUID(), l: ls[0]!, hours, doubleLessons: Math.min(doubles, Math.floor(hours / 2)) };
  });
  await db.transaction(async (tx) => {
    await tx.insert(timetableAssignments).values(rows.map((r) => ({ id: r.id, schoolYearId: year.id, subjectId: r.l.subjectId, hours: r.hours, doubleLessons: r.doubleLessons })));
    await tx.insert(timetableAssignmentGroups).values(rows.map((r) => ({ assignmentId: r.id, groupId: r.l.groupId })));
    const withTeacher = rows.filter((r) => r.l.teacherId);
    if (withTeacher.length) await tx.insert(timetableAssignmentTeachers).values(withTeacher.map((r) => ({ assignmentId: r.id, teacherId: r.l.teacherId! })));
  });
  if (actorId) await audit(db, actorId, "stundenplan.assignment.import", null, { count: rows.length });
  return rows.length;
}
