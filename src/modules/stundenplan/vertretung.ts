// Vertretungen: Entfall, Vertretung durch andere Lehrkraft, Raumänderung – je Stunde und Tag.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { bookingResources, bookings, groupMembers, groups, rooms, subjects, timetableLessons, timetableSubstitutionDays, timetableSubstitutions, users } from "@/core/db/schema";
import { OPEN_CALENDAR, dayOffLabel, dayOffOn, type SchoolCalendar } from "@/core/school/calendar";
import { addDays, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { SUBSTITUTION_KINDS, type TimetableLesson } from "./schema";
import { absencesBetween, absentGroups, absentTeachers } from "./abwesenheit";
import { blockLabel, roomBlockAt } from "./raumsperren";
import { lessonActiveOn } from "./service";
import { dayChanges, notifySubstitutionDay } from "./vertretung-gong";
import { draftDays, startDraftIfNeeded } from "./freigabe";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface SubstitutionInput {
  lessonId: string;
  date: string;
  kind: (typeof SUBSTITUTION_KINDS)[number];
  substituteId: string | null;
  roomId: string | null;
  note: string | null;
}

/** Wer ist zu dieser Stunde wirklich beschäftigt? Eigene Stunden (sofern nicht entfallen/abgegeben) + übernommene Vertretungen. */
async function busyTeachers(db: Db, date: string, weekday: number, periodNr: number, except: string[] = []): Promise<Set<string>> {
  const own = await db.select().from(timetableLessons).where(and(eq(timetableLessons.weekday, weekday), eq(timetableLessons.periodNr, periodNr)));
  const active = own.filter((l) => lessonActiveOn(l, date));
  const subs = active.length
    ? await db
        .select()
        .from(timetableSubstitutions)
        .where(and(eq(timetableSubstitutions.date, date), inArray(timetableSubstitutions.lessonId, active.map((l) => l.id))))
    : [];
  const subOf = new Map(subs.map((s) => [s.lessonId, s]));
  // Abwesenheiten (P2b-18): abwesende Lehrkräfte stehen nicht zur Verfügung; fehlt die Gruppe, ist ihre Lehrkraft frei
  const absences = await absencesBetween(db, date, date);
  const goneGroups = absentGroups(absences, date, periodNr);
  const busy = absentTeachers(absences, date, periodNr);
  for (const l of active) {
    const s = subOf.get(l.id);
    if (except.includes(l.id)) continue;
    if (l.teacherId && !goneGroups.has(l.groupId) && !(s && (s.kind === "cancel" || s.kind === "substitute"))) busy.add(l.teacherId);
    if (s?.kind === "substitute" && s.substituteId) busy.add(s.substituteId);
  }
  return busy;
}

/** Ist der Raum zu dieser Stunde belegt (reguläre Stunden, die dort bleiben, und hierher verlegte)? */
async function busyRooms(db: Db, date: string, weekday: number, periodNr: number, except: string[]): Promise<Set<string>> {
  const own = await db.select().from(timetableLessons).where(and(eq(timetableLessons.weekday, weekday), eq(timetableLessons.periodNr, periodNr)));
  const active = own.filter((l) => lessonActiveOn(l, date) && !except.includes(l.id));
  const subs = active.length
    ? await db
        .select()
        .from(timetableSubstitutions)
        .where(and(eq(timetableSubstitutions.date, date), inArray(timetableSubstitutions.lessonId, active.map((l) => l.id))))
    : [];
  const subOf = new Map(subs.map((s) => [s.lessonId, s]));
  const busy = new Set<string>();
  for (const l of active) {
    const s = subOf.get(l.id);
    if (s?.kind === "cancel") continue;
    const room = s?.roomId ?? l.roomId;
    if (room) busy.add(room);
  }
  // gebuchte Räume (Modul Buchungen) sind ebenfalls belegt
  const booked = await db
    .select({ roomId: bookingResources.roomId })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .where(and(eq(bookings.date, date), eq(bookings.periodNr, periodNr)));
  for (const b of booked) if (b.roomId) busy.add(b.roomId);
  return busy;
}

/** Welcher Unterricht belegt diesen Raum zu dieser Stunde (Vertretungen/Verlegungen berücksichtigt)? Für Buchungen. */
export async function roomLessonAt(db: Db, roomId: string, date: string, periodNr: number): Promise<{ groupName: string; subjectName: string } | null> {
  const weekday = weekdayMon0(date);
  if (weekday > 4 || (await dayOffOn(db, date))) return null;
  const rows = await db
    .select({ l: timetableLessons, groupName: groups.name, subjectName: subjects.name })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .where(and(eq(timetableLessons.weekday, weekday), eq(timetableLessons.periodNr, periodNr)));
  const active = rows.filter((r) => lessonActiveOn(r.l, date));
  if (active.length === 0) return null;
  const subs = await db
    .select()
    .from(timetableSubstitutions)
    .where(and(eq(timetableSubstitutions.date, date), inArray(timetableSubstitutions.lessonId, active.map((r) => r.l.id))));
  const subOf = new Map(subs.map((x) => [x.lessonId, x]));
  const hit = active.find((r) => {
    const x = subOf.get(r.l.id);
    return x?.kind !== "cancel" && (x?.roomId ?? r.l.roomId) === roomId;
  });
  return hit ? { groupName: hit.groupName, subjectName: hit.subjectName } : null;
}

/**
 * Teile derselben Kopplung bei derselben Lehrkraft (Religion für 7a und 7b bei RIC), die an `date` stattfinden –
 * eine Vertretung, ein Entfall oder eine Raumänderung gilt für alle zusammen.
 */
export async function couplingSiblings(db: Db, l: TimetableLesson, date: string): Promise<TimetableLesson[]> {
  if (!l.couplingId || !l.teacherId) return [];
  const rows = await db
    .select()
    .from(timetableLessons)
    .where(and(eq(timetableLessons.couplingId, l.couplingId), eq(timetableLessons.teacherId, l.teacherId)));
  return rows.filter((r) => r.id !== l.id && lessonActiveOn(r, date));
}

/** Lehrkräfte mit Angabe, ob sie zu dieser Stunde frei sind (für die Auswahl „Vertretung durch“). */
export async function teacherAvailability(db: Db, lessonId: string, date: string) {
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, lessonId));
  if (!l) return [];
  const busy = await busyTeachers(db, date, l.weekday, l.periodNr, [lessonId, ...(await couplingSiblings(db, l, date)).map((x) => x.id)]);
  const all = await db.select({ id: users.id, name: users.name, code: users.shortCode }).from(users).where(eq(users.role, "lehrkraft")).orderBy(asc(users.shortCode));
  return all.filter((t) => t.id !== l.teacherId).map((t) => ({ ...t, free: !busy.has(t.id) }));
}

export async function saveSubstitution(db: Db, actorId: string, input: SubstitutionInput): Promise<string> {
  const fe: Record<string, string> = {};
  if (!YMD.test(input.date)) fe.date = "Datum angeben";
  if (!SUBSTITUTION_KINDS.includes(input.kind)) fe.kind = "Art wählen";
  const [lesson] = await db
    .select({ l: timetableLessons, subjectName: subjects.name, groupName: groups.name })
    .from(timetableLessons)
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .where(eq(timetableLessons.id, input.lessonId));
  if (!lesson) fe.lessonId = "Stunde gibt es nicht";
  else if (YMD.test(input.date) && !lessonActiveOn(lesson.l, input.date)) fe.date = "An diesem Tag findet die Stunde nicht statt";
  else if (YMD.test(input.date)) {
    const off = await dayOffOn(db, input.date);
    if (off) fe.date = `Kein Unterricht: ${dayOffLabel(off)}`;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const l = lesson!.l;
  const siblings = await couplingSiblings(db, l, input.date);
  const all = [l, ...siblings];
  const except = all.map((x) => x.id);

  const sub = { ...input, note: input.note?.trim() || null };
  if (sub.kind === "cancel") {
    sub.substituteId = null;
    sub.roomId = null;
  }
  if (sub.kind === "room") sub.substituteId = null;
  if (sub.kind === "substitute") {
    if (!sub.substituteId) fe.substituteId = "Vertretungslehrkraft wählen";
    else {
      const [t] = await db.select({ role: users.role }).from(users).where(eq(users.id, sub.substituteId));
      if (t?.role !== "lehrkraft") fe.substituteId = "Vertretungslehrkraft wählen";
      else if (sub.substituteId === l.teacherId) fe.substituteId = "Das ist die eigene Lehrkraft der Stunde";
      else if (absentTeachers(await absencesBetween(db, sub.date, sub.date), sub.date, l.periodNr).has(sub.substituteId)) fe.substituteId = "Die Lehrkraft ist zu dieser Zeit abwesend";
      else if ((await busyTeachers(db, sub.date, l.weekday, l.periodNr, except)).has(sub.substituteId)) fe.substituteId = "Die Lehrkraft unterrichtet zu dieser Zeit selbst";
    }
  }
  if (sub.kind === "room" && !sub.roomId) fe.roomId = "Neuen Raum wählen";
  if (sub.roomId && sub.kind !== "cancel") {
    const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, sub.roomId));
    if (!r) fe.roomId = "Raum gibt es nicht";
    else if (sub.roomId === l.roomId) sub.roomId = null;
    else if ((await busyRooms(db, sub.date, l.weekday, l.periodNr, except)).has(sub.roomId)) fe.roomId = `Raum ${sub.roomId} ist zu dieser Zeit belegt`;
    else {
      const blk = await roomBlockAt(db, sub.roomId, sub.date, l.periodNr);
      if (blk) fe.roomId = `Raum ${sub.roomId}: ${blockLabel(blk)}`;
    }
  }
  if (sub.kind === "room" && !sub.roomId && !fe.roomId) fe.roomId = "Der Raum ist derselbe wie sonst";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  // bisherige Änderung (Vertretung wechselt → die bisherige Vertretung erfährt es auch)
  const previous = await db
    .select({ substituteId: timetableSubstitutions.substituteId })
    .from(timetableSubstitutions)
    .where(and(eq(timetableSubstitutions.date, sub.date), inArray(timetableSubstitutions.lessonId, except)));
  // gekoppelte Teile derselben Lehrkraft bekommen dieselbe Änderung
  const ids: string[] = [];
  await db.transaction(async (tx) => {
    // Q5-11: im Modus „Freigabe“ wird ein neuer Tag zum Entwurf (dann gibt es unten keinen Gong) – in derselben Transaktion
    // wie die Änderung, damit ein gescheitertes Speichern keinen leeren Entwurf hinterlässt (GATE-4f C-11)
    await startDraftIfNeeded(tx as unknown as Db, actorId, sub.date);
    for (const x of all) {
      const [row] = await tx
        .insert(timetableSubstitutions)
        .values({ ...sub, lessonId: x.id, createdBy: actorId })
        .onConflictDoUpdate({
          target: [timetableSubstitutions.lessonId, timetableSubstitutions.date],
          set: { kind: sub.kind, substituteId: sub.substituteId, roomId: sub.roomId, note: sub.note, createdBy: actorId, createdAt: new Date() },
        })
        .returning({ id: timetableSubstitutions.id });
      ids.push(row!.id);
    }
  });
  await audit(db, actorId, "stundenplan.substitution.save", l.groupId, { lesson: l.id, date: sub.date, kind: sub.kind, coupled: siblings.length || undefined });

  // Gong an alle Betroffenen (Q5-03): eine Nachricht je Person und Tag – Schüler:innen, Lehrkraft, Vertretung (auch die
  // bisherige, wenn sie wechselt), Eltern nach Moduleinstellung
  await notifySubstitutionDay(db, actorId, sub.date, {
    students: await studentsOf(db, all.map((x) => x.groupId)),
    teachers: [l.teacherId, sub.substituteId, ...previous.map((p) => p.substituteId)].filter((x): x is string => !!x),
  });
  return ids[0]!;
}

/** Löscht die Änderung – bei Kopplungen auch die der anderen Teile derselben Lehrkraft am selben Tag. */
export async function deleteSubstitution(db: Db, actorId: string, id: string): Promise<void> {
  const [old] = await db.delete(timetableSubstitutions).where(eq(timetableSubstitutions.id, id)).returning();
  if (!old) return;
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, old.lessonId));
  const siblings = l ? await couplingSiblings(db, l, old.date) : [];
  if (siblings.length)
    await db
      .delete(timetableSubstitutions)
      .where(and(eq(timetableSubstitutions.date, old.date), inArray(timetableSubstitutions.lessonId, siblings.map((x) => x.id))));
  await audit(db, actorId, "stundenplan.substitution.delete", old.lessonId, { date: old.date, kind: old.kind });
  // Q5-03: Zurücknehmen ist auch eine Änderung (Entfall fällt weg → das Kind kommt doch nicht früher) – Tagesnachricht erneuern
  if (l)
    await notifySubstitutionDay(db, actorId, old.date, {
      students: await studentsOf(db, [l, ...siblings].map((x) => x.groupId)),
      teachers: [l.teacherId, old.substituteId].filter((x): x is string => !!x),
    });
}

/**
 * Q5-11: Entwurf eines Tages veröffentlichen – ab jetzt sehen alle die Änderungen, und jede betroffene Person bekommt die
 * gebündelte Tagesnachricht (Q5-03). Gibt `null` zurück, wenn der Tag kein Entwurf (mehr) ist, sonst die Zahl der Empfänger.
 */
export async function publishDay(db: Db, actorId: string, date: string): Promise<number | null> {
  if (!YMD.test(date)) throw new ValidationError({ date: "Datum angeben" });
  let published = false;
  let changeCount = 0;
  const recipients = await notifySubstitutionDay(
    db,
    actorId,
    date,
    // GATE-4f C-01: Empfänger erst unter der Tagessperre ermitteln – wer während des Veröffentlichens speichert, ist dabei
    async (tx) => {
      const changes = await dayChanges(tx, date);
      changeCount = changes.length;
      return {
        students: await studentsOf(tx, [...new Set(changes.map((c) => c.groupId))]),
        teachers: [...new Set(changes.flatMap((c) => [c.teacherId, c.substituteId]).filter((x): x is string => !!x))],
      };
    },
    async (tx) => {
      const rows = await tx
        .update(timetableSubstitutionDays)
        .set({ publishedAt: new Date(), publishedBy: actorId })
        .where(and(eq(timetableSubstitutionDays.date, date), isNull(timetableSubstitutionDays.publishedAt)))
        .returning({ date: timetableSubstitutionDays.date });
      published = rows.length > 0;
      return published;
    },
  );
  if (!published) return null;
  await audit(db, actorId, "stundenplan.substitution.publish", null, { date, changes: changeCount, recipients: recipients.length });
  return recipients.length;
}

/** Schüler:innen der Gruppen (Empfänger des Vertretungs-Gongs). */
async function studentsOf(db: Db, groupIds: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, [...groupIds]), eq(users.role, "schueler")));
  return [...new Set(rows.map((r) => r.id))];
}

export interface DaySubstitution {
  id: string;
  lessonId: string;
  date: string;
  kind: "cancel" | "substitute" | "room";
  periodNr: number;
  groupId: string;
  groupName: string;
  gradeLevel: number | null;
  subjectName: string;
  color: string;
  teacherCode: string | null;
  substituteCode: string | null;
  substituteName: string | null;
  roomId: string | null;
  newRoomId: string | null;
  note: string | null;
  /** Q5-11: Tag ist noch Entwurf (nur mit `drafts: true` enthalten) */
  draft: boolean;
}

/**
 * Alle Änderungen an einem oder mehreren Tagen (Vertretungsplan, Monitor, Verwaltung). Q5-11: Tage im Entwurf nur mit
 * `drafts: true` (Planung mit `stundenplan.manage`) – alle anderen sehen den veröffentlichten Stand.
 */
export async function substitutionsOn(db: Db, dates: string[], opts: { drafts?: boolean } = {}): Promise<DaySubstitution[]> {
  if (dates.length === 0) return [];
  const drafts = await draftDays(db, dates);
  const visible = opts.drafts ? dates : dates.filter((d) => !drafts.has(d));
  if (visible.length === 0) return [];
  const teacher = alias(users, "teacher");
  const substitute = alias(users, "substitute");
  const rows = await db
    .select({
      s: timetableSubstitutions,
      l: timetableLessons,
      groupName: groups.name,
      gradeLevel: groups.gradeLevel,
      subjectName: subjects.name,
      color: subjects.color,
      teacherCode: teacher.shortCode,
      substituteCode: substitute.shortCode,
      substituteName: substitute.name,
    })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .leftJoin(teacher, eq(teacher.id, timetableLessons.teacherId))
    .leftJoin(substitute, eq(substitute.id, timetableSubstitutions.substituteId))
    .where(inArray(timetableSubstitutions.date, visible));
  return rows
    .map((r) => ({
      id: r.s.id,
      lessonId: r.l.id,
      date: r.s.date,
      kind: r.s.kind,
      periodNr: r.l.periodNr,
      groupId: r.l.groupId,
      groupName: r.groupName,
      gradeLevel: r.gradeLevel,
      subjectName: r.subjectName,
      color: r.color,
      teacherCode: r.teacherCode,
      substituteCode: r.substituteCode,
      substituteName: r.substituteName,
      roomId: r.l.roomId,
      newRoomId: r.s.roomId,
      note: r.s.note,
      draft: drafts.has(r.s.date),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.groupName.localeCompare(b.groupName, "de", { numeric: true }) || a.periodNr - b.periodNr);
}

/** Die beiden Tage des Vertretungsplans: heute (sonst der nächste Schultag) und der Schultag danach. */
export function planDays(today: string, cal: SchoolCalendar = OPEN_CALENDAR): [string, string] {
  const first = cal.nextSchoolDay(today);
  return [first, cal.nextSchoolDay(addDays(first, 1))];
}
