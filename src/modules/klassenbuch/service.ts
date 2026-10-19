// Klassenbuch: Eintrag je gehaltener Stunde (Thema, Hausaufgabe) + Fehlzeiten der Gruppe.
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { classbookAbsences, classbookEntries, groupMembers, groups, subjects, timetableLessons, timetableSubstitutions, users } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { dayOffLabel, dayOffOn, loadSchoolCalendar } from "@/core/school/calendar";
import { addDays } from "@/core/time";
import { excusedStateOn } from "@/modules/abwesenheiten/service";
import { onLeave } from "@/modules/abwesenheiten/wirkung";
import { listSlots, lessonActiveOn, type LessonSlot } from "@/modules/stundenplan/service";
import { couplingSiblings } from "@/modules/stundenplan/vertretung";
import { isDraftDay } from "@/modules/stundenplan/freigabe";
import { ValidationError } from "@/modules/verwaltung/users";
import { de } from "@/core/db/sort";

export interface AbsenceInput {
  studentId: string;
  kind: "absent" | "late";
  minutesLate: number | null;
}

export interface EntryInput {
  lessonId: string;
  date: string;
  topic: string;
  homework: string;
  /** Q5-27: „fällig am“ (YYYY-MM-DD) oder leer = nächste Stunde derselben Gruppe im Fach */
  homeworkDue?: string;
  absences: AbsenceInput[];
  /** Thema und Hausaufgabe auch in die anderen Gruppen der Kopplung (gleiche Lehrkraft) übernehmen */
  alsoCoupled?: boolean;
}

export interface LessonContext {
  lessonId: string;
  date: string;
  groupId: string;
  groupName: string;
  periodNr: number;
  subjectId: string;
  subjectName: string;
  color: string;
  /** Raum der Stunde an dem Tag (Vertretung/Raumänderung berücksichtigt) – für den passenden Sitzplan (P5-03) */
  roomId: string | null;
  /** wer die Stunde an diesem Tag hält (Vertretung berücksichtigt) */
  teacherId: string | null;
  students: { id: string; name: string }[];
  entry: { id: string; topic: string; homework: string | null; homeworkDue: string | null; teacherId: string | null } | null;
  absences: Map<string, { kind: "absent" | "late"; minutesLate: number | null; excused: boolean | null }>;
  /** Q5-16: Schüler:innen mit genehmigter Beurlaubung an diesem Tag */
  onLeave: Set<string>;
  /** andere Gruppen derselben Kopplung bei derselben Lehrkraft an diesem Tag */
  coupled: { lessonId: string; groupId: string; groupName: string; subjectId: string; periodNr: number }[];
}

/** Stunde an einem Tag mit allem, was der Eintrag braucht. Wirft, wenn die Stunde an dem Tag nicht stattfindet. */
export async function lessonContext(db: Db, lessonId: string, date: string): Promise<LessonContext> {
  const [row] = await db
    .select({ l: timetableLessons, groupName: groups.name, subjectName: subjects.name, color: subjects.color })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .where(eq(timetableLessons.id, lessonId));
  if (!row || !lessonActiveOn(row.l, date)) throw new ValidationError({ lessonId: "Diese Stunde findet an dem Tag nicht statt" });
  const off = await dayOffOn(db, date);
  if (off) throw new ValidationError({ lessonId: `Kein Unterricht: ${dayOffLabel(off)}` });
  const [stored] = await db
    .select()
    .from(timetableSubstitutions)
    .where(and(eq(timetableSubstitutions.lessonId, lessonId), eq(timetableSubstitutions.date, date)));
  // Q5-11: Änderungen im noch nicht veröffentlichten Entwurf gelten (noch) nicht
  const sub = stored && !(await isDraftDay(db, date)) ? stored : undefined;
  if (sub?.kind === "cancel") throw new ValidationError({ lessonId: "Die Stunde ist entfallen" });

  const [students, [entry]] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, lastName: users.lastName, firstName: users.firstName })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, row.l.groupId), eq(users.role, "schueler")))
      .orderBy(de(users.lastName), de(users.firstName)),
    db
      .select({
        id: classbookEntries.id,
        topic: classbookEntries.topic,
        homework: classbookEntries.homework,
        homeworkDue: classbookEntries.homeworkDue,
        teacherId: classbookEntries.teacherId,
      })
      .from(classbookEntries)
      .where(and(eq(classbookEntries.lessonId, lessonId), eq(classbookEntries.date, date))),
  ]);
  const absences = entry ? await db.select().from(classbookAbsences).where(eq(classbookAbsences.entryId, entry.id)) : [];
  const siblings = await couplingSiblings(db, row.l, date);
  // SP-12 (Fachtausch): die Vertretung gibt ein anderes Fach – der Eintrag trägt das tatsächlich unterrichtete Fach
  const [alt] = sub?.kind === "substitute" && sub.subjectId ? await db.select({ id: subjects.id, name: subjects.name, color: subjects.color }).from(subjects).where(eq(subjects.id, sub.subjectId)) : [];
  const siblingGroups = siblings.length ? await db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, siblings.map((x) => x.groupId))) : [];
  // deutsche Sortierung (Umlaute) statt C-Collation der DB (TD-01)
  students.sort((a, b) => a.lastName.localeCompare(b.lastName, "de") || a.firstName.localeCompare(b.firstName, "de"));
  return {
    lessonId,
    date,
    groupId: row.l.groupId,
    groupName: row.groupName,
    periodNr: row.l.periodNr,
    subjectId: alt?.id ?? row.l.subjectId,
    subjectName: alt?.name ?? row.subjectName,
    color: alt?.color ?? row.color,
    roomId: sub?.roomId ?? row.l.roomId,
    teacherId: sub?.kind === "substitute" ? sub.substituteId : row.l.teacherId,
    students: students.map((s) => ({ id: s.id, name: s.name })),
    entry: entry ?? null,
    absences: new Map(absences.map((a) => [a.studentId, { kind: a.kind, minutesLate: a.minutesLate, excused: a.excused }])),
    onLeave: await onLeave(db, students.map((s) => s.id), date),
    coupled: siblings.map((x) => ({
      lessonId: x.id,
      groupId: x.groupId,
      groupName: siblingGroups.find((g) => g.id === x.groupId)?.name ?? x.groupId,
      subjectId: alt?.id ?? x.subjectId,
      periodNr: x.periodNr,
    })),
  };
}

/** Schreiben darf, wer die Stunde an dem Tag hält – oder wer alle Einträge bearbeiten darf. */
export function canWrite(viewer: PermissionSet, ctx: Pick<LessonContext, "teacherId">): boolean {
  return ctx.teacherId === viewer.userId || hasPermission(viewer, "klassenbuch.manage");
}

/** Lesen: wer schreiben darf, Klassenleitung (Gruppenleitung) der Gruppe, „alle einsehen“. */
export function canRead(viewer: PermissionSet, ctx: Pick<LessonContext, "teacherId" | "groupId">): boolean {
  return canWrite(viewer, ctx) || viewer.leaderOf.has(ctx.groupId) || hasPermission(viewer, "klassenbuch.view_all");
}

export async function saveEntry(db: Db, viewer: PermissionSet, input: EntryInput, todayYmd: string): Promise<string> {
  const ctx = await lessonContext(db, input.lessonId, input.date);
  if (!canWrite(viewer, ctx)) throw new ForbiddenError("klassenbuch.write");
  const fe: Record<string, string> = {};
  if (input.date > todayYmd) fe.date = "Einträge für künftige Stunden sind nicht möglich";
  if (!input.topic.trim()) fe.topic = "Thema der Stunde angeben";
  if (input.topic.length > 500) fe.topic = "Thema bitte kürzer fassen (max. 500 Zeichen)";
  if (input.homework.length > 1000) fe.homework = "Hausaufgabe bitte kürzer fassen";
  const homeworkDue = input.homework.trim() ? await checkHomeworkDue(db, input.homeworkDue ?? "", ctx, todayYmd, fe) : null;
  const ids = new Set(ctx.students.map((s) => s.id));
  for (const a of input.absences) {
    if (!ids.has(a.studentId)) fe.absences = "Unbekannte Person in der Anwesenheitsliste";
    if (a.kind === "late" && !(a.minutesLate !== null && a.minutesLate > 0 && a.minutesLate <= 90)) fe[`late-${a.studentId}`] = "Minuten (1–90) angeben";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);

  const values = {
    lessonId: ctx.lessonId,
    date: ctx.date,
    groupId: ctx.groupId,
    periodNr: ctx.periodNr,
    subjectId: ctx.subjectId,
    topic: input.topic.trim(),
    homework: input.homework.trim() || null,
    homeworkDue,
  };
  let entryId = ctx.entry?.id;
  if (entryId) await db.update(classbookEntries).set({ subjectId: values.subjectId, topic: values.topic, homework: values.homework, homeworkDue }).where(eq(classbookEntries.id, entryId));
  else {
    const [row] = await db
      .insert(classbookEntries)
      .values({ ...values, teacherId: viewer.userId })
      .returning({ id: classbookEntries.id });
    entryId = row!.id;
  }
  // Kopplung: Thema und Hausaufgabe für die anderen Gruppen derselben Lehrkraft (Fehlzeiten trägt jede Gruppe selbst)
  if (input.alsoCoupled) {
    for (const c of ctx.coupled) {
      await db
        .insert(classbookEntries)
        .values({ lessonId: c.lessonId, date: ctx.date, groupId: c.groupId, periodNr: c.periodNr, subjectId: c.subjectId, topic: values.topic, homework: values.homework, homeworkDue, teacherId: viewer.userId })
        .onConflictDoUpdate({ target: [classbookEntries.lessonId, classbookEntries.date], set: { subjectId: c.subjectId, topic: values.topic, homework: values.homework, homeworkDue } });
    }
  }

  // Fehlzeiten abgleichen; ein bereits gesetztes „entschuldigt“ bleibt erhalten,
  // neue Fehlstunden übernehmen eine Entscheidung aus „Abwesenheiten“ für diesen Tag
  const wanted = new Map(input.absences.map((a) => [a.studentId, a]));
  const decided = await excusedStateOn(db, [...wanted.keys()].filter((id) => !ctx.absences.has(id)), ctx.date);
  const removed = [...ctx.absences.keys()].filter((id) => !wanted.has(id));
  if (removed.length) await db.delete(classbookAbsences).where(and(eq(classbookAbsences.entryId, entryId), inArray(classbookAbsences.studentId, removed)));
  for (const a of wanted.values()) {
    const minutesLate = a.kind === "late" ? a.minutesLate : null;
    if (ctx.absences.has(a.studentId)) {
      await db
        .update(classbookAbsences)
        .set({ kind: a.kind, minutesLate })
        .where(and(eq(classbookAbsences.entryId, entryId), eq(classbookAbsences.studentId, a.studentId)));
    } else {
      await db.insert(classbookAbsences).values({ entryId, studentId: a.studentId, kind: a.kind, minutesLate, excused: a.kind === "absent" ? decided.get(a.studentId) : undefined });
    }
  }
  await audit(db, viewer.userId, "klassenbuch.entry.save", ctx.groupId, { date: ctx.date, period: ctx.periodNr, absences: wanted.size });
  return entryId;
}

/** so weit voraus darf „fällig am“ liegen */
export const HOMEWORK_DUE_MAX_DAYS = 60;

/**
 * Q5-27: „fällig am“ prüfen. Leer = null (nächste Stunde). Sonst ein Schultag nach dem Tag der Stunde, ab morgen
 * (ein unverändert übernommenes Datum eines bestehenden Eintrags darf inzwischen vorbei sein) und höchstens 60 Tage voraus.
 */
async function checkHomeworkDue(db: Db, raw: string, ctx: Pick<LessonContext, "date" | "entry">, todayYmd: string, fe: Record<string, string>): Promise<string | null> {
  const due = raw.trim();
  if (!due) return null;
  const parsed = new Date(`${due}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== due) {
    fe.homeworkDue = "Datum ungültig";
    return null;
  }
  const unchanged = ctx.entry?.homeworkDue === due;
  if (due <= ctx.date) fe.homeworkDue = "Das Datum muss nach der Stunde liegen";
  else if (!unchanged && due <= todayYmd) fe.homeworkDue = "Fällig frühestens morgen";
  else if (due > addDays(todayYmd > ctx.date ? todayYmd : ctx.date, HOMEWORK_DUE_MAX_DAYS)) fe.homeworkDue = `Höchstens ${HOMEWORK_DUE_MAX_DAYS} Tage im Voraus`;
  else if (!unchanged && !(await loadSchoolCalendar(db)).isSchoolDay(due)) fe.homeworkDue = "Bitte einen Schultag wählen (kein Wochenende, Feiertag oder Ferientag)";
  return due;
}

export interface MySlot extends LessonSlot {
  hasEntry: boolean;
}

/** Stunden, die die Lehrkraft an diesen Tagen hält (Vertretungen eingeschlossen, Entfall/abgegeben nicht), mit Eintragsstatus. */
export async function mySlots(db: Db, teacherId: string, fromYmd: string, days = 1): Promise<MySlot[]> {
  const slots = (await listSlots(db, { kind: "teacher", id: teacherId }, fromYmd, addDays(fromYmd, days))).filter(
    (s) => s.change?.kind !== "cancel" && s.perspective !== "away",
  );
  if (slots.length === 0) return [];
  const entries = await db
    .select({ lessonId: classbookEntries.lessonId, date: classbookEntries.date })
    .from(classbookEntries)
    .where(inArray(classbookEntries.lessonId, [...new Set(slots.map((s) => s.lessonId))]));
  const has = new Set(entries.map((e) => `${e.lessonId}:${e.date}`));
  return slots.map((s) => ({ ...s, hasEntry: has.has(`${s.lessonId}:${s.date}`) }));
}

export type WeekCellStatus = "done" | "missing" | "future" | "cancelled";

export interface WeekCell extends LessonSlot {
  status: WeekCellStatus;
  entry: { topic: string; homework: string | null } | null;
}

/** Wochenraster einer Gruppe mit Eintragsstatus (fehlende Einträge bis einschließlich heute). */
export async function classWeek(db: Db, groupId: string, monday: string, todayYmd: string): Promise<WeekCell[]> {
  const slots = await listSlots(db, { kind: "group", id: groupId }, monday, addDays(monday, 5));
  const entries = slots.length
    ? await db
        .select({ lessonId: classbookEntries.lessonId, date: classbookEntries.date, topic: classbookEntries.topic, homework: classbookEntries.homework })
        .from(classbookEntries)
        .where(and(eq(classbookEntries.groupId, groupId), inArray(classbookEntries.date, [...new Set(slots.map((s) => s.date))])))
    : [];
  const byKey = new Map(entries.map((e) => [`${e.lessonId}:${e.date}`, e]));
  return slots.map((s) => {
    const e = byKey.get(`${s.lessonId}:${s.date}`);
    const status: WeekCellStatus = s.change?.kind === "cancel" ? "cancelled" : e ? "done" : s.date > todayYmd ? "future" : "missing";
    return { ...s, status, entry: e ? { topic: e.topic, homework: e.homework } : null };
  });
}

export interface AbsenceSum {
  studentId: string;
  name: string;
  /** Fehlstunden gesamt */
  absent: number;
  excused: number;
  unexcused: number;
  open: number;
  lateCount: number;
  lateMinutes: number;
}

/** Fehlzeiten je Schüler:in der Gruppe im Zeitraum [fromYmd, toYmd] – über alle Stunden (auch Kurse/AGs). */
export async function absenceSummary(db: Db, groupId: string, fromYmd: string, toYmd: string): Promise<AbsenceSum[]> {
  const students = await db
    .select({ id: users.id, name: users.name, lastName: users.lastName, firstName: users.firstName })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(users.role, "schueler")));
  if (students.length === 0) return [];
  const rows = await db
    .select({ studentId: classbookAbsences.studentId, kind: classbookAbsences.kind, minutesLate: classbookAbsences.minutesLate, excused: classbookAbsences.excused })
    .from(classbookAbsences)
    .innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId))
    .where(and(inArray(classbookAbsences.studentId, students.map((s) => s.id)), gte(classbookEntries.date, fromYmd), lte(classbookEntries.date, toYmd)));
  const sums = new Map<string, AbsenceSum>(students.map((s) => [s.id, { studentId: s.id, name: s.name, absent: 0, excused: 0, unexcused: 0, open: 0, lateCount: 0, lateMinutes: 0 }]));
  for (const r of rows) {
    const x = sums.get(r.studentId)!;
    if (r.kind === "late") {
      x.lateCount++;
      x.lateMinutes += r.minutesLate ?? 0;
      continue;
    }
    x.absent++;
    if (r.excused === true) x.excused++;
    else if (r.excused === false) x.unexcused++;
    else x.open++;
  }
  const order = new Map(students.map((s) => [s.id, s]));
  return [...sums.values()].sort(
    (a, b) => b.absent - a.absent || order.get(a.studentId)!.lastName.localeCompare(order.get(b.studentId)!.lastName, "de") || a.name.localeCompare(b.name, "de"),
  );
}

/** Klassen, deren Klassenbuch der Betrachter als Übersicht sehen darf. */
export async function readableClasses(db: Db, viewer: PermissionSet) {
  const all = await db
    .select({ id: groups.id, name: groups.name, gradeLevel: groups.gradeLevel })
    .from(groups)
    .where(and(eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
  const visible = hasPermission(viewer, "klassenbuch.view_all") ? all : all.filter((g) => viewer.leaderOf.has(g.id));
  return visible.sort((a, b) => (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.name.localeCompare(b.name, "de", { numeric: true }));
}

export function canReadClass(viewer: PermissionSet, groupId: string): boolean {
  return viewer.leaderOf.has(groupId) || hasPermission(viewer, "klassenbuch.view_all");
}
