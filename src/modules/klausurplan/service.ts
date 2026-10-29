// Klausurplan: Klassenarbeiten/Klausuren je Gruppe mit Regelprüfung je Schüler:in
// (höchstens eine am Tag, höchstens drei in der Woche – auch über Kurse hinweg).
import { and, asc, count, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { exams, groupMembers, groups, periods, rooms, subjects, timetableLessons, users } from "@/core/db/schema";
import { childrenOf } from "@/core/school/majority";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { dayOffLabel, dayOffOn } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, mondayOf, weekdayMon0 } from "@/core/time";
import type { Occurrence } from "@/modules/kalender/service";
import { isStaffRole } from "@/core/roles";
import { examSeatWarning, examSeatsByRoom } from "@/modules/verwaltung/raumlayout";
import { ValidationError } from "@/modules/verwaltung/users";
import { EXAM_KINDS } from "./schema";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PER_WEEK = 3;
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
export const KIND_LABEL = { klassenarbeit: "Klassenarbeit", klausur: "Klausur", test: "Test" } as const;

export interface ExamInput {
  groupId: string;
  subjectId: string;
  kind: (typeof EXAM_KINDS)[number];
  title: string;
  date: string;
  periodFrom: number;
  periodTo: number;
  roomId: string | null;
  /** Ausnahme von den Regeln (nur mit klausurplan.manage) */
  override: boolean;
}

/** Gruppen, für die der Betrachter Arbeiten eintragen darf: alle Klassen/Kurse (manage) bzw. eigene Unterrichtsgruppen. */
export async function plannableExamGroups(db: Db, viewer: PermissionSet) {
  if (!hasPermission(viewer, "klausurplan.plan")) return [];
  const all = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel, subjectId: groups.subjectId })
    .from(groups)
    .where(inArray(groups.kind, ["klasse", "kurs"]));
  let allowed: Set<string>;
  if (hasPermission(viewer, "klausurplan.manage")) allowed = new Set(all.map((g) => g.id));
  else {
    const taught = await db.selectDistinct({ g: timetableLessons.groupId }).from(timetableLessons).where(eq(timetableLessons.teacherId, viewer.userId));
    allowed = new Set([...taught.map((t) => t.g), ...viewer.memberOf]);
  }
  return all
    .filter((g) => allowed.has(g.id) && (g.gradeLevel ?? 0) > 0)
    .sort((a, b) => (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.name.localeCompare(b.name, "de", { numeric: true }));
}

/** Regelverstöße für eine neue/geänderte Arbeit der Gruppe an `date` – leeres Array = alles gut. */
export async function ruleViolations(db: Db, groupId: string, date: string, excludeId?: string): Promise<string[]> {
  const students = (
    await db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, groupId), eq(users.role, "schueler")))
  ).map((s) => s.id);
  if (students.length === 0) return [];
  const memberships = await db.select({ userId: groupMembers.userId, groupId: groupMembers.groupId }).from(groupMembers).where(inArray(groupMembers.userId, students));
  const groupsOf = new Map<string, Set<string>>();
  for (const m of memberships) groupsOf.set(m.userId, (groupsOf.get(m.userId) ?? new Set()).add(m.groupId));
  const monday = mondayOf(date);
  const week = await db
    .select({ e: exams, groupName: groups.name, subjectName: subjects.name })
    .from(exams)
    .innerJoin(groups, eq(groups.id, exams.groupId))
    .innerJoin(subjects, eq(subjects.id, exams.subjectId))
    .where(
      and(
        inArray(exams.groupId, [...new Set(memberships.map((m) => m.groupId))]),
        gte(exams.date, monday),
        lte(exams.date, addDays(monday, 6)),
        excludeId ? ne(exams.id, excludeId) : undefined,
      ),
    );
  const sameDay = new Map<string, string>(); // examId → Beschreibung
  let dayStudents = 0;
  let weekStudents = 0;
  for (const s of students) {
    const mine = week.filter((x) => groupsOf.get(s)!.has(x.e.groupId));
    const today = mine.filter((x) => x.e.date === date);
    if (today.length) {
      dayStudents++;
      for (const x of today) sameDay.set(x.e.id, `${x.subjectName} (${x.groupName})`);
    }
    if (mine.length + 1 > MAX_PER_WEEK) weekStudents++;
  }
  const out: string[] = [];
  const who = (n: number) => (n === students.length ? "Alle Schüler:innen der Gruppe haben" : `${n} Schüler:innen haben`);
  if (dayStudents) out.push(`${who(dayStudents)} an diesem Tag schon eine Arbeit: ${[...sameDay.values()].join(", ")}`);
  if (weekStudents) out.push(`${who(weekStudents)} in dieser Woche schon ${MAX_PER_WEEK} Arbeiten`);
  return out;
}

export async function createExam(db: Db, viewer: PermissionSet, input: ExamInput, todayYmd: string): Promise<string> {
  const fe: Record<string, string> = {};
  const allowed = new Set((await plannableExamGroups(db, viewer)).map((g) => g.id));
  if (!allowed.has(input.groupId)) throw new ForbiddenError("klausurplan.plan");
  if (!EXAM_KINDS.includes(input.kind)) fe.kind = "Art wählen";
  if (!input.title.trim()) fe.title = "Bezeichnung angeben, z. B. „2. Klassenarbeit“";
  if (!YMD.test(input.date)) fe.date = "Datum angeben";
  else if (input.date < todayYmd) fe.date = "Das Datum liegt in der Vergangenheit";
  else if (weekdayMon0(input.date) > 4) fe.date = "Am Wochenende finden keine Arbeiten statt";
  else {
    const off = await dayOffOn(db, input.date);
    if (off) fe.date = `Kein Unterricht: ${dayOffLabel(off)}`;
  }
  const ps = new Set((await db.select({ nr: periods.nr }).from(periods)).map((p) => p.nr));
  if (!ps.has(input.periodFrom) || !ps.has(input.periodTo) || input.periodTo < input.periodFrom) fe.periodFrom = "Stunden prüfen";
  const [s] = await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, input.subjectId));
  if (!s) fe.subjectId = "Fach wählen";
  if (input.roomId) {
    const [r] = await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.active, true)));
    if (!r) fe.roomId = "Raum gibt es nicht (mehr)";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const violations = await ruleViolations(db, input.groupId, input.date);
  if (violations.length && !(input.override && hasPermission(viewer, "klausurplan.manage"))) throw new ValidationError({ date: violations.join(" · ") });

  const [row] = await db
    .insert(exams)
    .values({
      groupId: input.groupId,
      subjectId: input.subjectId,
      kind: input.kind,
      title: input.title.trim(),
      date: input.date,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      roomId: input.roomId,
      teacherId: viewer.userId,
    })
    .returning({ id: exams.id });
  await audit(db, viewer.userId, "klausurplan.create", input.groupId, { date: input.date, override: violations.length > 0 });
  // Gong an die Schüler:innen der Gruppe
  const [subj] = await db.select({ name: subjects.name }).from(subjects).where(eq(subjects.id, input.subjectId));
  const students = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(users.role, "schueler")));
  await notify(db, students.map((x) => x.id), {
    moduleId: "klausurplan",
    title: `${KIND_LABEL[input.kind]} ${subj?.name}: ${shortDay.format(fromBerlinLocal(input.date))}`,
    body: input.title.trim(),
    href: "/klausurplan",
  });
  return row!.id;
}

export async function deleteExam(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  const [e] = await db.select().from(exams).where(eq(exams.id, id));
  if (!e) return;
  if (e.teacherId !== viewer.userId && !hasPermission(viewer, "klausurplan.manage")) throw new ForbiddenError("klausurplan.manage");
  await db.delete(exams).where(eq(exams.id, id));
  await audit(db, viewer.userId, "klausurplan.delete", e.groupId, { date: e.date });
}

export interface ExamRow {
  id: string;
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  color: string;
  kind: "klassenarbeit" | "klausur" | "test";
  title: string;
  date: string;
  periodFrom: number;
  periodTo: number;
  startsAt: string;
  endsAt: string;
  roomId: string | null;
  teacherId: string | null;
  teacherCode: string | null;
}

/** Gruppen, deren Arbeiten der Betrachter sieht: eigene (Schüler:innen), die der Kinder, Unterrichts-/Mitgliedsgruppen; manage: alle. */
async function visibleGroupIds(db: Db, viewer: PermissionSet): Promise<string[] | null> {
  if (hasPermission(viewer, "klausurplan.manage")) return null;
  if (viewer.role === "eltern") {
    // Q5-05: eigenständige Kinder nur mit deren Einwilligung
    const kids = (await childrenOf(db, viewer.userId, "inform")).map((k) => k.id);
    if (kids.length === 0) return [];
    return (await db.selectDistinct({ g: groupMembers.groupId }).from(groupMembers).where(inArray(groupMembers.userId, kids))).map((r) => r.g);
  }
  const taught = viewer.role === "schueler" ? [] : (await db.selectDistinct({ g: timetableLessons.groupId }).from(timetableLessons).where(eq(timetableLessons.teacherId, viewer.userId))).map((t) => t.g);
  return [...new Set([...viewer.memberOf, ...taught])];
}

export async function listExams(db: Db, viewer: PermissionSet, fromYmd: string, toYmd: string, onlyGroupIds?: string[]): Promise<ExamRow[]> {
  const visible = await visibleGroupIds(db, viewer);
  let ids = onlyGroupIds ?? visible;
  if (onlyGroupIds && visible) ids = onlyGroupIds.filter((g) => visible.includes(g));
  if (ids && ids.length === 0) return [];
  const teacher = alias(users, "teacher");
  const pFrom = alias(periods, "p_from");
  const pTo = alias(periods, "p_to");
  const rows = await db
    .select({ e: exams, groupName: groups.name, subjectName: subjects.name, color: subjects.color, teacherCode: teacher.shortCode, startsAt: pFrom.startsAt, endsAt: pTo.endsAt })
    .from(exams)
    .innerJoin(groups, eq(groups.id, exams.groupId))
    .innerJoin(subjects, eq(subjects.id, exams.subjectId))
    .innerJoin(pFrom, eq(pFrom.nr, exams.periodFrom))
    .innerJoin(pTo, eq(pTo.nr, exams.periodTo))
    .leftJoin(teacher, eq(teacher.id, exams.teacherId))
    .where(and(ids ? inArray(exams.groupId, ids) : undefined, gte(exams.date, fromYmd), lte(exams.date, addDays(toYmd, -1))))
    .orderBy(asc(exams.date), asc(exams.periodFrom));
  return rows.map((r) => ({
    id: r.e.id,
    groupId: r.e.groupId,
    groupName: r.groupName,
    subjectId: r.e.subjectId,
    subjectName: r.subjectName,
    color: r.color,
    kind: r.e.kind,
    title: r.e.title,
    date: r.e.date,
    periodFrom: r.e.periodFrom,
    periodTo: r.e.periodTo,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    roomId: r.e.roomId,
    teacherId: r.e.teacherId,
    teacherCode: r.teacherCode,
  }));
}

/** Text für eine Stunde, in der die Arbeit liegt – mit Fach, wenn es nicht das Fach der Stunde ist. */
export function examLabel(e: ExamRow, slotSubjectId: string): string {
  return `${KIND_LABEL[e.kind]}${e.subjectId === slotSubjectId ? "" : ` ${e.subjectName}`} · ${e.title}`;
}

/** Für Stundenplan/Tagesleiste: Arbeit je „Gruppe:Datum:Stunde“. */
export function examIndex(rows: readonly ExamRow[]): Map<string, ExamRow> {
  const out = new Map<string, ExamRow>();
  for (const e of rows) for (let p = e.periodFrom; p <= e.periodTo; p++) out.set(`${e.groupId}:${e.date}:${p}`, e);
  return out;
}

/** Arbeiten als Kalendertermine (nur lesend, Klick führt zum Klausurplan). */
export async function examOccurrences(db: Db, viewer: PermissionSet, fromYmd: string, toYmd: string): Promise<Occurrence[]> {
  return (await listExams(db, viewer, fromYmd, toYmd)).map((e) => ({
    eventId: `exam-${e.id}`,
    key: "school" as const,
    calendar: "Klassenarbeiten",
    color: e.color,
    title: `${KIND_LABEL[e.kind]} ${e.subjectName} (${e.groupName.replace(/^Klasse /, "")})`,
    location: e.roomId,
    description: e.title,
    start: fromBerlinLocal(`${e.date}T${e.startsAt}`),
    end: fromBerlinLocal(`${e.date}T${e.endsAt}`),
    allDay: false,
    recurring: false,
    ownerId: null,
    href: "/klausurplan",
  }));
}

// ------------------------------------------------------------------ RS-09: Prüfungsplätze aus dem Raumlayout

/** Schüler:innen je Gruppe (für den Abgleich mit den Prüfungsplätzen). */
async function studentCounts(db: Db, groupIds: readonly string[]): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const rows = await db
    .select({ g: groupMembers.groupId, n: count() })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, [...new Set(groupIds)]), eq(users.role, "schueler"), eq(users.status, "active")))
    .groupBy(groupMembers.groupId);
  return new Map(rows.map((r) => [r.g, Number(r.n)]));
}

/**
 * Warnungen bei Überbelegung (RS-09, nur als Hinweis – das Eintragen wird nie blockiert): mehr Schüler:innen als
 * Prüfungsplätze im Raum laut Raumlayout (Variante „Prüfung“ bzw. jeder zweite Platz des Standard-Layouts). Nur für
 * Beschäftigte – Layouts sind nicht für Schüler:innen und Eltern. Arbeiten ohne Raum oder Räume ohne Layout: keine Warnung.
 */
export async function examSeatWarnings(db: Db, viewer: PermissionSet, list: readonly Pick<ExamRow, "id" | "groupId" | "roomId">[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const withRoom = list.filter((e) => e.roomId);
  if (!isStaffRole(viewer.role) || withRoom.length === 0) return out;
  const [seats, students] = await Promise.all([examSeatsByRoom(db, withRoom.map((e) => e.roomId!)), studentCounts(db, withRoom.map((e) => e.groupId))]);
  for (const e of withRoom) {
    const w = examSeatWarning(students.get(e.groupId) ?? 0, seats.get(e.roomId!), e.roomId!);
    if (w) out.set(e.id, w);
  }
  return out;
}
