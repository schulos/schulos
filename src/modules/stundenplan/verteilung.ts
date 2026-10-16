// Unterrichtsverteilung (P2b-08): Lehraufträge je Schuljahr und Abgleich Soll ↔ verplant im Stundenplan.
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
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
  timetableLessons,
  users,
} from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { de } from "@/core/db/sort";

/** Gruppenarten, für die Unterricht verteilt wird */
export const PLANNED_GROUP_KINDS = ["klasse", "kurs", "ag", "wahlpflicht", "foerderkurs"] as const;

export interface AssignmentInput {
  schoolYearId: string;
  groupIds: string[];
  subjectId: string;
  hours: number;
  teacherIds: string[];
  doubleLessons: number;
  roomId: string | null;
  note: string | null;
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
  groups: { id: string; name: string }[];
  teachers: { id: string; code: string | null; name: string }[];
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
    .orderBy(asc(subjects.sortOrder), asc(subjects.name), asc(timetableAssignments.createdAt));
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
}

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
    perGroup.set(key(pick.id, l.groupId), (perGroup.get(key(pick.id, l.groupId)) ?? 0) + l.weight);
  }
  const byAssignment = new Map<string, AssignmentStatus>();
  for (const a of assignments) {
    const planned = a.groupIds.length ? Math.min(...a.groupIds.map((g) => perGroup.get(key(a.id, g)) ?? 0)) : 0;
    byAssignment.set(a.id, { planned, otherTeacher: other.has(a.id) });
  }
  return { byAssignment, unmatched };
}

/** Stunden, die am Stichtag gelten (unabhängig vom Wochentag), mit Gewicht nach A/B-Woche. */
export async function planLessonsOn(db: Db, refYmd: string): Promise<PlanLesson[]> {
  const rows = await db
    .select({ id: timetableLessons.id, groupId: timetableLessons.groupId, subjectId: timetableLessons.subjectId, teacherId: timetableLessons.teacherId, week: timetableLessons.week })
    .from(timetableLessons)
    .where(and(lte(timetableLessons.validFrom, refYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, refYmd))))
    .orderBy(asc(timetableLessons.weekday), asc(timetableLessons.periodNr));
  return rows.map(({ week, ...r }) => ({ ...r, weight: week === "all" ? 1 : 0.5 }));
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
  groups: GroupTotals[];
  teachers: TeacherTotals[];
  unmatched: (PlanLesson & { groupName: string; subjectName: string; teacherCode: string | null })[];
  /** Stundentafel je Jahrgang und Fach */
  curriculum: Map<number, Map<string, number>>;
  subjectNames: Map<string, string>;
}

/** Komplette Unterrichtsverteilung eines Schuljahres mit Soll/verplant je Auftrag, Gruppe und Lehrkraft. */
export async function distribution(db: Db, year: { id: string; startsOn: string; endsOn: string }, todayYmd: string): Promise<Distribution> {
  const refYmd = referenceDate(year, todayYmd);
  const [list, lessons, groupRows, teacherRows, tafel, subjectRows] = await Promise.all([
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
  const { byAssignment, unmatched } = matchLessons(
    list.map((a) => ({ id: a.id, subjectId: a.subjectId, hours: a.hours, groupIds: a.groups.map((g) => g.id), teacherIds: a.teachers.map((t) => t.id) })),
    lessons,
  );
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
    assigned: sum(list.filter((a) => a.teachers.some((x) => x.id === t.id)).map((a) => a.hours)),
    planned: sum(lessons.filter((l) => l.teacherId === t.id).map((l) => l.weight)),
  }));
  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));
  const subjectName = new Map(subjectRows.map((s) => [s.id, s.name]));
  const teacherCode = new Map(teacherRows.map((t) => [t.id, t.code]));
  return {
    refYmd,
    assignments: list.map((a) => ({ ...a, ...byAssignment.get(a.id)! })),
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

async function validate(db: Db, input: AssignmentInput, excludeId?: string): Promise<void> {
  const fe: Record<string, string> = {};
  const groupIds = [...new Set(input.groupIds)];
  const teacherIds = [...new Set(input.teacherIds)];
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 12) fe.hours = "1 bis 12 Wochenstunden";
  else if (!Number.isInteger(input.doubleLessons) || input.doubleLessons < 0 || input.doubleLessons * 2 > input.hours)
    fe.doubleLessons = `höchstens ${Math.floor(input.hours / 2)} Doppelstunden bei ${input.hours} Wochenstunden`;
  if (input.note && input.note.length > 200) fe.note = "höchstens 200 Zeichen";
  const [[y], [s], gs, ts, r] = await Promise.all([
    db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, input.schoolYearId)),
    db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, input.subjectId)),
    groupIds.length ? db.select({ id: groups.id, kind: groups.kind }).from(groups).where(inArray(groups.id, groupIds)) : Promise.resolve([]),
    teacherIds.length ? db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, teacherIds)) : Promise.resolve([]),
    input.roomId ? db.select({ id: rooms.id, active: rooms.active }).from(rooms).where(eq(rooms.id, input.roomId)) : Promise.resolve([{ id: "", active: true }]),
  ]);
  if (!y) fe.schoolYearId = "Schuljahr gibt es nicht";
  if (!s) fe.subjectId = "Fach wählen";
  if (!groupIds.length) fe.groupIds = "Mindestens eine Klasse oder einen Kurs wählen";
  else if (gs.length !== groupIds.length || gs.some((g) => !(PLANNED_GROUP_KINDS as readonly string[]).includes(g.kind))) fe.groupIds = "Gruppe ist keine Klasse und kein Kurs";
  if (ts.length !== teacherIds.length || ts.some((t) => t.role !== "lehrkraft")) fe.teacherIds = "Lehrkraft wählen";
  if (!r[0]?.active) fe.roomId = "Raum gibt es nicht oder ist inaktiv";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  // Doppelt erfasst? Gleiches Fach in einer der Gruppen bei einer der Lehrkräfte (bzw. beide ohne Lehrkraft)
  const others = (await listAssignments(db, input.schoolYearId)).filter((a) => a.id !== excludeId && a.subjectId === input.subjectId);
  for (const o of others) {
    const sharedGroup = o.groups.find((g) => groupIds.includes(g.id));
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
  await db.insert(timetableAssignmentGroups).values([...new Set(input.groupIds)].map((groupId) => ({ assignmentId: id, groupId })));
  const teacherIds = [...new Set(input.teacherIds)];
  if (teacherIds.length) await db.insert(timetableAssignmentTeachers).values(teacherIds.map((teacherId) => ({ assignmentId: id, teacherId })));
}

const values = (i: AssignmentInput) => ({
  schoolYearId: i.schoolYearId,
  subjectId: i.subjectId,
  hours: i.hours,
  doubleLessons: i.doubleLessons,
  roomId: i.roomId,
  note: i.note?.trim() || null,
});

export async function createAssignment(db: Db, actorId: string, input: AssignmentInput): Promise<string> {
  await validate(db, input);
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(timetableAssignments).values(values(input)).returning({ id: timetableAssignments.id });
    await writeLinks(tx, row!.id, input);
    return row!.id;
  });
  await audit(db, actorId, "stundenplan.assignment.create", input.groupIds[0], { subject: input.subjectId, hours: input.hours, groups: input.groupIds.length });
  return id;
}

export async function updateAssignment(db: Db, actorId: string, id: string, input: AssignmentInput): Promise<void> {
  const [old] = await db.select({ id: timetableAssignments.id }).from(timetableAssignments).where(eq(timetableAssignments.id, id));
  if (!old) throw new ValidationError({ id: "Lehrauftrag gibt es nicht mehr" });
  await validate(db, input, id);
  await db.transaction(async (tx) => {
    await tx.update(timetableAssignments).set(values(input)).where(eq(timetableAssignments.id, id));
    await writeLinks(tx, id, input);
  });
  await audit(db, actorId, "stundenplan.assignment.update", input.groupIds[0], { assignment: id, subject: input.subjectId, hours: input.hours });
}

export async function deleteAssignment(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableAssignments).where(eq(timetableAssignments.id, id)).returning();
  if (old) await audit(db, actorId, "stundenplan.assignment.delete", null, { subject: old.subjectId, hours: old.hours });
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
