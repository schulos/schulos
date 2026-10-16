// Elternsprechtag (P4-50): Sprechtage, Verfügbarkeit der Lehrkräfte, Buchung und Absage – mit Kollisionsprüfung und den
// Sichtbarkeitsregeln. Wer bucht: Eltern für minderjährige Kinder (`majority.ts`, Modus „handeln“), eigenständige
// (volljährige) Schüler:innen für sich selbst. Eltern sehen bei Lehrkräften nur frei/belegt, nie andere Familien.
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import {
  groupMembers,
  groups,
  rooms,
  schoolYears,
  sprechtagAppointments,
  sprechtagAvailability,
  sprechtagEvents,
  sprechtagInvitations,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
  type SprechtagBreak,
  type SprechtagEvent,
} from "@/core/db/schema";
import { notify, notifyBundled } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { childrenOf, isParentFor, isSelfResponsible, parentLinks } from "@/core/school/majority";
import { TZ, fromBerlinLocal, isCalendarDate, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { checkRaster, slotsFor, suggestSequence } from "./slots";

export const MANAGE = "sprechtag.manage";
export const OFFER = "sprechtag.offer";
/** Gruppenarten, in denen Lehrkräfte ein Kind unterrichten (nicht AG, Gremium, Fachschaft) */
export const TEACHING_KINDS = ["klasse", "kurs", "wahlpflicht", "foerderkurs"] as const;

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
export const formatEventDay = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

// ------------------------------------------------------------------ Sprechtage

export interface EventInput {
  title: string;
  date: string;
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
  breaks: SprechtagBreak[];
  bookingOpensOn: string;
  bookingClosesOn: string;
}

export type EventState = "geplant" | "buchung" | "geschlossen" | "vorbei";

/** Rein: Stand eines Sprechtags an `today` – vor dem Buchungsfenster, Buchung offen, Buchung zu, vorbei. */
export function eventState(e: Pick<SprechtagEvent, "date" | "bookingOpensOn" | "bookingClosesOn">, today: string): EventState {
  if (today > e.date) return "vorbei";
  if (today < e.bookingOpensOn) return "geplant";
  if (today > e.bookingClosesOn) return "geschlossen";
  return "buchung";
}

export const STATE_LABEL: Record<EventState, string> = {
  geplant: "Buchung noch nicht offen",
  buchung: "Buchung offen",
  geschlossen: "Buchung geschlossen",
  vorbei: "vorbei",
};

function checkEvent(input: EventInput, today: string): Record<string, string> {
  const fe: Record<string, string> = { ...checkRaster(input) };
  if (!input.title.trim()) fe.title = "Titel angeben";
  if (!isCalendarDate(input.date)) fe.date = "Datum angeben";
  else if (input.date < today) fe.date = "Das Datum liegt in der Vergangenheit";
  if (!isCalendarDate(input.bookingOpensOn)) fe.bookingOpensOn = "Ersten Buchungstag angeben";
  if (!isCalendarDate(input.bookingClosesOn)) fe.bookingClosesOn = "Letzten Buchungstag angeben";
  else if (isCalendarDate(input.bookingOpensOn) && input.bookingClosesOn < input.bookingOpensOn) fe.bookingClosesOn = "Der letzte Buchungstag liegt vor dem ersten";
  else if (isCalendarDate(input.date) && input.bookingClosesOn > input.date) fe.bookingClosesOn = "Die Buchung muss spätestens am Sprechtag enden";
  return fe;
}

const clean = (input: EventInput) => ({
  title: input.title.trim().slice(0, 120),
  date: input.date,
  startsAt: input.startsAt,
  endsAt: input.endsAt,
  slotMinutes: input.slotMinutes,
  breaks: input.breaks,
  bookingOpensOn: input.bookingOpensOn,
  bookingClosesOn: input.bookingClosesOn,
});

export async function createEvent(db: Db, perms: PermissionSet, input: EventInput, today: string): Promise<string> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const fe = checkEvent(input, today);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db.insert(sprechtagEvents).values(clean(input)).returning({ id: sprechtagEvents.id });
  await audit(db, perms.userId, "sprechtag.event.create", row!.id, { title: input.title.trim(), date: input.date });
  return row!.id;
}

/** Ändern: gebuchte Termine müssen ins neue Raster passen (sonst erst absagen). */
export async function updateEvent(db: Db, perms: PermissionSet, id: string, input: EventInput, today: string): Promise<void> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const before = await getEvent(db, id);
  if (!before) throw new ValidationError({ title: "Diesen Sprechtag gibt es nicht mehr" });
  const fe = checkEvent(input, before.date < today ? before.date : today);
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const booked = await db.select({ slot: sprechtagAppointments.slot }).from(sprechtagAppointments).where(eq(sprechtagAppointments.eventId, id));
  const slots = new Set(slotsFor(input));
  const outside = [...new Set(booked.map((b) => b.slot).filter((s) => !slots.has(s)))];
  if (booked.length && input.date !== before.date) throw new ValidationError({ date: "Es gibt schon gebuchte Termine – das Datum lässt sich nicht mehr ändern" });
  if (outside.length) throw new ValidationError({ startsAt: `Gebuchte Termine passen nicht ins neue Raster (${outside.sort().join(", ")}) – erst absagen` });
  await db.update(sprechtagEvents).set(clean(input)).where(eq(sprechtagEvents.id, id));
  await audit(db, perms.userId, "sprechtag.event.update", id, { title: input.title.trim(), date: input.date });
}

/** Löschen: Lehrkräfte und Familien mit Termin bekommen einen Gong. */
export async function deleteEvent(db: Db, perms: PermissionSet, id: string): Promise<void> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const e = await getEvent(db, id);
  if (!e) return;
  const appts = await db.select().from(sprechtagAppointments).where(eq(sprechtagAppointments.eventId, id));
  // G4D-C05: die Familie nur über `familyRecipients` (handelnde Eltern bzw. die eigenständige Person) – wer früher gebucht
  // hat, aber nicht mehr für das Kind handelt (eigenständig, Verknüpfung gelöst), erfährt nichts mehr
  const families = await familyRecipients(db, appts.map((a) => a.studentId));
  const people = [...new Set([...appts.map((a) => a.teacherId), ...families])];
  await db.delete(sprechtagEvents).where(eq(sprechtagEvents.id, id));
  await notify(db, people, { moduleId: "sprechtag", title: `Sprechtag abgesagt: ${e.title} (${formatEventDay(e.date)})`, body: "Alle Termine dieses Sprechtags sind entfallen.", href: "/sprechtag" });
  await audit(db, perms.userId, "sprechtag.event.delete", id, { title: e.title, date: e.date, appointments: appts.length });
}

export async function getEvent(db: Db, id: string): Promise<SprechtagEvent | null> {
  const [e] = await db.select().from(sprechtagEvents).where(eq(sprechtagEvents.id, id));
  return e ?? null;
}

/** Sprechtage für die Übersicht: Verwaltung alle (neueste zuerst), sonst nur kommende (nächster zuerst). */
export async function listEvents(db: Db, perms: PermissionSet, today: string): Promise<SprechtagEvent[]> {
  if (hasPermission(perms, MANAGE)) return db.select().from(sprechtagEvents).orderBy(desc(sprechtagEvents.date));
  return db.select().from(sprechtagEvents).where(gte(sprechtagEvents.date, today)).orderBy(asc(sprechtagEvents.date));
}

/** Der nächste Sprechtag ab heute (Widget, Monitor). */
export async function nextEvent(db: Db, today: string): Promise<SprechtagEvent | null> {
  const [e] = await db.select().from(sprechtagEvents).where(gte(sprechtagEvents.date, today)).orderBy(asc(sprechtagEvents.date), asc(sprechtagEvents.startsAt)).limit(1);
  return e ?? null;
}

// ------------------------------------------------------------------ Wer unterrichtet wen, wer bucht für wen

/** Lehrkräfte, die das Kind am Tag `date` unterrichten (Stundenplan, Unterrichtsverteilung) oder in seinen Lerngruppen sind. */
export async function teachersOfStudent(db: Db, studentId: string, date: string): Promise<string[]> {
  const myGroups = db
    .select({ id: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, studentId), inArray(groups.kind, [...TEACHING_KINDS]), isNull(groups.archivedAt)));
  const [lessons, assigned, members] = await Promise.all([
    db
      .selectDistinct({ id: timetableLessons.teacherId })
      .from(timetableLessons)
      .where(
        and(
          inArray(timetableLessons.groupId, myGroups),
          lte(timetableLessons.validFrom, date),
          or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, date)),
        ),
      ),
    db
      .selectDistinct({ id: timetableAssignmentTeachers.teacherId })
      .from(timetableAssignmentTeachers)
      .innerJoin(timetableAssignments, eq(timetableAssignments.id, timetableAssignmentTeachers.assignmentId))
      .innerJoin(timetableAssignmentGroups, eq(timetableAssignmentGroups.assignmentId, timetableAssignments.id))
      .innerJoin(schoolYears, eq(schoolYears.id, timetableAssignments.schoolYearId))
      .where(and(inArray(timetableAssignmentGroups.groupId, myGroups), lte(schoolYears.startsOn, date), gte(schoolYears.endsOn, date))),
    db
      .selectDistinct({ id: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(inArray(groupMembers.groupId, myGroups), eq(users.role, "lehrkraft"))),
  ]);
  const ids = new Set([...lessons, ...assigned, ...members].map((r) => r.id).filter((x): x is string => Boolean(x)));
  if (ids.size === 0) return [];
  const active = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.role, "lehrkraft"), eq(users.status, "active")));
  return active.map((r) => r.id);
}

export interface BookingStudent {
  id: string;
  name: string;
  firstName: string;
  className: string | null;
}

/** Klassen der Schüler:innen (aktive Klassengruppe). */
export async function classNames(db: Db, studentIds: readonly string[]): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: groupMembers.userId, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(inArray(groupMembers.userId, [...studentIds]), eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
  return new Map(rows.map((r) => [r.userId, r.name.replace(/^Klasse /, "")]));
}

/** Für wen bucht diese Person? Eltern: minderjährige Kinder · eigenständige Schüler:innen: sich selbst · sonst niemand. */
export async function bookingStudents(db: Db, perms: PermissionSet): Promise<BookingStudent[]> {
  let list: { id: string; name: string; firstName: string }[] = [];
  if (perms.role === "eltern") list = await childrenOf(db, perms.userId, "act");
  else if (perms.role === "schueler" && (await isSelfResponsible(db, perms.userId))) {
    const [me] = await db.select({ id: users.id, name: users.name, firstName: users.firstName }).from(users).where(eq(users.id, perms.userId));
    list = me ? [me] : [];
  }
  const cls = await classNames(
    db,
    list.map((s) => s.id),
  );
  return list.map((s) => ({ ...s, className: cls.get(s.id) ?? null })).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/** Handelt `perms` für dieses Kind (Elternteil eines Minderjährigen bzw. die eigenständige Person selbst)? */
export async function actsFor(db: Db, perms: PermissionSet, studentId: string): Promise<boolean> {
  if (perms.role === "eltern") return isParentFor(db, perms.userId, studentId, "act");
  if (perms.role === "schueler" && perms.userId === studentId) return isSelfResponsible(db, studentId);
  return false;
}

/** Wer an Stelle „der Familie“ informiert wird: handelnde Eltern bzw. die eigenständige Person selbst. */
export async function familyRecipients(db: Db, studentIds: readonly string[]): Promise<string[]> {
  if (studentIds.length === 0) return [];
  const unique = [...new Set(studentIds)];
  const self = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.selfResponsible, true)));
  const links = await parentLinks(db, unique, "act");
  return [...new Set([...self.map((s) => s.id), ...links.map((l) => l.parentId)])];
}

// ------------------------------------------------------------------ Verfügbarkeit der Lehrkräfte

/** Vorgabe-Raum: Stammraum der Klasse, die die Lehrkraft leitet. */
export async function defaultRoom(db: Db, teacherId: string): Promise<string | null> {
  const [r] = await db
    .select({ roomId: groups.homeRoomId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, teacherId), eq(groupMembers.role, "leader"), eq(groups.kind, "klasse"), isNull(groups.archivedAt)))
    .limit(1);
  return r?.roomId ?? null;
}

export async function getAvailability(db: Db, eventId: string, teacherId: string) {
  const [a] = await db
    .select()
    .from(sprechtagAvailability)
    .where(and(eq(sprechtagAvailability.eventId, eventId), eq(sprechtagAvailability.teacherId, teacherId)));
  return a ?? null;
}

/**
 * Lehrkraft gibt ihre Zeiten frei (bzw. ändert Raum und gesperrte Zeiten). Schon gebuchte Zeiten lassen sich nicht sperren.
 * Nur für die eigene Person (die id kommt aus der Sitzung).
 */
export async function releaseAvailability(
  db: Db,
  perms: PermissionSet,
  eventId: string,
  input: { roomId: string | null; blockedSlots: string[] },
  today: string,
): Promise<void> {
  if (!hasPermission(perms, OFFER)) throw new ForbiddenError(OFFER);
  const e = await getEvent(db, eventId);
  if (!e || eventState(e, today) === "vorbei") throw new ValidationError({ roomId: "Dieser Sprechtag ist vorbei" });
  const slots = new Set(slotsFor(e));
  const blocked = [...new Set(input.blockedSlots)].filter((s) => slots.has(s)).sort();
  const fe: Record<string, string> = {};
  if (input.roomId) {
    const [room] = await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.active, true)));
    if (!room) fe.roomId = "Raum wählen";
  }
  if (blocked.length >= slots.size) fe.blockedSlots = "Mindestens eine Zeit anbieten";
  const booked = await db
    .select({ slot: sprechtagAppointments.slot })
    .from(sprechtagAppointments)
    .where(and(eq(sprechtagAppointments.eventId, eventId), eq(sprechtagAppointments.teacherId, perms.userId), inArray(sprechtagAppointments.slot, blocked.length ? blocked : ["-"])));
  if (booked.length) fe.blockedSlots = `Schon gebucht: ${booked.map((b) => b.slot).sort().join(", ")} – erst absagen, dann sperren`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  await db
    .insert(sprechtagAvailability)
    .values({ eventId, teacherId: perms.userId, roomId: input.roomId, blockedSlots: blocked })
    .onConflictDoUpdate({ target: [sprechtagAvailability.eventId, sprechtagAvailability.teacherId], set: { roomId: input.roomId, blockedSlots: blocked } });
}

/** Lehrkraft nimmt nicht (mehr) teil – nur, solange nichts gebucht ist. */
export async function withdrawAvailability(db: Db, perms: PermissionSet, eventId: string): Promise<void> {
  if (!hasPermission(perms, OFFER)) throw new ForbiddenError(OFFER);
  const [hit] = await db
    .select({ id: sprechtagAppointments.id })
    .from(sprechtagAppointments)
    .where(and(eq(sprechtagAppointments.eventId, eventId), eq(sprechtagAppointments.teacherId, perms.userId)))
    .limit(1);
  if (hit) throw new ValidationError({ roomId: "Es sind schon Termine gebucht – erst absagen" });
  await db.delete(sprechtagAvailability).where(and(eq(sprechtagAvailability.eventId, eventId), eq(sprechtagAvailability.teacherId, perms.userId)));
}

export interface TeacherBoard {
  teacherId: string;
  name: string;
  shortCode: string | null;
  roomId: string | null;
  roomName: string | null;
  /** angebotene, noch freie Zeiten */
  free: string[];
  /** belegte Zeiten (ohne Namen) */
  taken: string[];
}

/** Lehrkräfte mit Teilnahme und ihren freien/belegten Zeiten – ohne Namen der Familien. */
export async function teacherBoards(db: Db, e: SprechtagEvent, teacherIds?: readonly string[]): Promise<TeacherBoard[]> {
  if (teacherIds && teacherIds.length === 0) return [];
  const conds = [eq(sprechtagAvailability.eventId, e.id)];
  if (teacherIds) conds.push(inArray(sprechtagAvailability.teacherId, [...teacherIds]));
  const [avail, booked] = await Promise.all([
    db
      .select({
        teacherId: sprechtagAvailability.teacherId,
        name: users.name,
        lastName: users.lastName,
        shortCode: users.shortCode,
        roomId: sprechtagAvailability.roomId,
        roomName: rooms.name,
        blocked: sprechtagAvailability.blockedSlots,
      })
      .from(sprechtagAvailability)
      .innerJoin(users, eq(users.id, sprechtagAvailability.teacherId))
      .leftJoin(rooms, eq(rooms.id, sprechtagAvailability.roomId))
      .where(and(...conds))
      .orderBy(de(users.lastName), de(users.firstName)),
    db.select({ teacherId: sprechtagAppointments.teacherId, slot: sprechtagAppointments.slot }).from(sprechtagAppointments).where(eq(sprechtagAppointments.eventId, e.id)),
  ]);
  const slots = slotsFor(e);
  return avail.map((a) => {
    const taken = new Set(booked.filter((b) => b.teacherId === a.teacherId).map((b) => b.slot));
    const blocked = new Set(a.blocked);
    return {
      teacherId: a.teacherId,
      name: a.name,
      shortCode: a.shortCode,
      roomId: a.roomId,
      roomName: a.roomName,
      free: slots.filter((s) => !blocked.has(s) && !taken.has(s)),
      taken: slots.filter((s) => taken.has(s)),
    };
  });
}

// ------------------------------------------------------------------ Buchen und absagen

export interface BookingInput {
  teacherId: string;
  studentId: string;
  slot: string;
}

/** Buchungsfenster offen? (Verwaltung bucht auch außerhalb, solange der Tag nicht vorbei ist.) */
function assertBookable(e: SprechtagEvent, perms: PermissionSet, today: string) {
  const state = eventState(e, today);
  if (state === "buchung") return;
  if (state !== "vorbei" && hasPermission(perms, MANAGE)) return;
  throw new ValidationError({ slot: state === "geplant" ? "Die Buchung ist noch nicht offen" : "Die Buchung ist geschlossen" });
}

/**
 * Bucht einen oder mehrere Termine – alles oder nichts. Prüft: Buchungsfenster, handelt die Person für das Kind,
 * unterrichtet die Lehrkraft das Kind, bietet sie die Zeit an, ist die Zeit frei, hat die Familie bzw. das Kind dann
 * schon einen Termin. Gibt die IDs der Termine zurück.
 */
export async function bookAppointments(db: Db, perms: PermissionSet, eventId: string, items: readonly BookingInput[], now = new Date(), today = toBerlinDate(now)): Promise<string[]> {
  const e = await getEvent(db, eventId);
  if (!e) throw new ValidationError({ slot: "Diesen Sprechtag gibt es nicht mehr" });
  if (items.length === 0) throw new ValidationError({ slot: "Keine Termine gewählt" });
  assertBookable(e, perms, today);
  const slots = new Set(slotsFor(e));
  const students = [...new Set(items.map((i) => i.studentId))];
  for (const s of students) if (!(await actsFor(db, perms, s))) throw new ForbiddenError("sprechtag.book");
  const teachersOf = new Map<string, Set<string>>();
  for (const s of students) teachersOf.set(s, new Set(await teachersOfStudent(db, s, e.date)));
  const boards = new Map((await teacherBoards(db, e)).map((b) => [b.teacherId, b]));
  // Termine der Familie: eigene Buchungen und alle Termine der Kinder, für die gebucht wird
  const mine = await db
    .select({ slot: sprechtagAppointments.slot, studentId: sprechtagAppointments.studentId, teacherId: sprechtagAppointments.teacherId })
    .from(sprechtagAppointments)
    .where(and(eq(sprechtagAppointments.eventId, eventId), or(eq(sprechtagAppointments.bookedBy, perms.userId), inArray(sprechtagAppointments.studentId, students))));
  const busy = new Set(mine.map((m) => m.slot));
  const pairs = new Set(mine.map((m) => `${m.teacherId}:${m.studentId}`));
  for (const it of items) {
    const board = boards.get(it.teacherId);
    if (!slots.has(it.slot)) throw new ValidationError({ slot: `${it.slot} liegt nicht im Raster` });
    if (!teachersOf.get(it.studentId)!.has(it.teacherId)) throw new ValidationError({ teacherId: "Diese Lehrkraft unterrichtet das Kind nicht" });
    if (!board) throw new ValidationError({ teacherId: "Diese Lehrkraft bietet an diesem Sprechtag keine Termine an" });
    if (!board.free.includes(it.slot)) throw new ValidationError({ slot: `Um ${it.slot} ist bei ${board.name} kein Termin mehr frei` });
    if (busy.has(it.slot)) throw new ValidationError({ slot: `Um ${it.slot} haben Sie schon einen Termin` });
    if (pairs.has(`${it.teacherId}:${it.studentId}`)) throw new ValidationError({ teacherId: `Bei ${board.name} ist für dieses Kind schon ein Termin gebucht` });
    busy.add(it.slot);
    pairs.add(`${it.teacherId}:${it.studentId}`);
  }
  // gleichzeitige Buchungen: die eindeutigen Indizes entscheiden; dann alles zurück
  const ids = await db.transaction(async (tx) => {
    // G4D-C07: je buchender Person und Sprechtag serialisieren und die Familien-Kollision danach erneut prüfen – zwei Tabs
    // derselben Person (verschiedene Kinder, verschiedene Lehrkräfte, gleiche Zeit) deckt kein eindeutiger Index ab
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sprechtag:${eventId}:${perms.userId}`}))`);
    const taken = await tx
      .select({ slot: sprechtagAppointments.slot })
      .from(sprechtagAppointments)
      .where(and(eq(sprechtagAppointments.eventId, eventId), or(eq(sprechtagAppointments.bookedBy, perms.userId), inArray(sprechtagAppointments.studentId, students))));
    const clash = items.find((it) => taken.some((t) => t.slot === it.slot));
    if (clash) throw new ValidationError({ slot: `Um ${clash.slot} haben Sie gerade schon einen Termin gebucht – bitte neu wählen` });
    const out: string[] = [];
    for (const it of items) {
      const [row] = await tx
        .insert(sprechtagAppointments)
        .values({ eventId, teacherId: it.teacherId, studentId: it.studentId, bookedBy: perms.userId, slot: it.slot, startsAt: fromBerlinLocal(`${e.date}T${it.slot}`) })
        .onConflictDoNothing()
        .returning({ id: sprechtagAppointments.id });
      if (!row) throw new ValidationError({ slot: `Um ${it.slot} ist gerade ein anderer Termin gebucht worden – bitte neu wählen` });
      out.push(row.id);
    }
    return out;
  });
  await audit(db, perms.userId, "sprechtag.book", eventId, { count: ids.length });
  await notifyTeachers(db, e, [...new Set(items.map((i) => i.teacherId))]);
  return ids;
}

/** Gebündelter Gong je Lehrkraft und Sprechtag: „n Termine gebucht“ (wird bei jeder Buchung aktualisiert). */
async function notifyTeachers(db: Db, e: SprechtagEvent, teacherIds: readonly string[]): Promise<void> {
  const rows = await db
    .select({ teacherId: sprechtagAppointments.teacherId })
    .from(sprechtagAppointments)
    .where(and(eq(sprechtagAppointments.eventId, e.id), inArray(sprechtagAppointments.teacherId, [...teacherIds])));
  await notifyBundled(
    db,
    teacherIds.map((t) => {
      const n = rows.filter((r) => r.teacherId === t).length;
      return { userId: t, title: `Sprechtag: ${n === 1 ? "1 Termin" : `${n} Termine`} gebucht`, body: `${e.title}, ${formatEventDay(e.date)}`, href: `/sprechtag/${e.id}` };
    }),
    { moduleId: "sprechtag", bundleKey: `sprechtag:${e.id}` },
  );
}

export interface AppointmentView {
  id: string;
  eventId: string;
  slot: string;
  teacherId: string;
  teacherName: string;
  teacherCode: string | null;
  roomName: string | null;
  studentId: string;
  studentName: string;
  className: string | null;
  bookedBy: string;
  bookedByName: string;
}

async function appointmentViews(db: Db, where: ReturnType<typeof and>): Promise<AppointmentView[]> {
  const teacher = users;
  const rows = await db
    .select({
      id: sprechtagAppointments.id,
      eventId: sprechtagAppointments.eventId,
      slot: sprechtagAppointments.slot,
      teacherId: sprechtagAppointments.teacherId,
      teacherName: teacher.name,
      teacherCode: teacher.shortCode,
      roomName: rooms.name,
      studentId: sprechtagAppointments.studentId,
      bookedBy: sprechtagAppointments.bookedBy,
    })
    .from(sprechtagAppointments)
    .innerJoin(teacher, eq(teacher.id, sprechtagAppointments.teacherId))
    .leftJoin(sprechtagAvailability, and(eq(sprechtagAvailability.eventId, sprechtagAppointments.eventId), eq(sprechtagAvailability.teacherId, sprechtagAppointments.teacherId)))
    .leftJoin(rooms, eq(rooms.id, sprechtagAvailability.roomId))
    .where(where)
    .orderBy(asc(sprechtagAppointments.slot), asc(teacher.lastName));
  const personIds = [...new Set(rows.flatMap((r) => [r.studentId, r.bookedBy]))];
  const people = personIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds)) : [];
  const names = new Map(people.map((p) => [p.id, p.name]));
  const cls = await classNames(
    db,
    rows.map((r) => r.studentId),
  );
  return rows.map((r) => ({
    ...r,
    studentName: names.get(r.studentId) ?? "",
    className: cls.get(r.studentId) ?? null,
    bookedByName: names.get(r.bookedBy) ?? "",
  }));
}

/**
 * Termine einer Familie: Kinder, für die die Person handelt (bzw. sie selbst) – und mit `informed` zusätzlich, nur lesend,
 * eigenständige Kinder, deren Eltern informiert werden dürfen (Einwilligung, Q5-05).
 */
export async function familyAppointments(db: Db, perms: PermissionSet, eventId: string, opts: { informed?: boolean } = {}): Promise<AppointmentView[]> {
  const ids = (await bookingStudents(db, perms)).map((s) => s.id);
  if (opts.informed && perms.role === "eltern") ids.push(...(await childrenOf(db, perms.userId, "inform")).map((c) => c.id));
  if (ids.length === 0) return [];
  return appointmentViews(db, and(eq(sprechtagAppointments.eventId, eventId), inArray(sprechtagAppointments.studentId, [...new Set(ids)])));
}

/** Plan einer Lehrkraft (eigene Person, oder mit `sprechtag.manage` jede). */
export async function teacherAppointments(db: Db, perms: PermissionSet, eventId: string, teacherId: string): Promise<AppointmentView[]> {
  if (teacherId !== perms.userId && !hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  return appointmentViews(db, and(eq(sprechtagAppointments.eventId, eventId), eq(sprechtagAppointments.teacherId, teacherId)));
}

/** Alle Termine eines Sprechtags – nur mit `sprechtag.manage`. */
export async function allAppointments(db: Db, perms: PermissionSet, eventId: string): Promise<AppointmentView[]> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  return appointmentViews(db, eq(sprechtagAppointments.eventId, eventId));
}

/**
 * Absage: die Familie (bis zum Sprechtag), die Lehrkraft oder die Verwaltung. Der Termin wird gelöscht; die jeweils
 * andere Seite bekommt einen Gong.
 */
export async function cancelAppointment(db: Db, perms: PermissionSet, appointmentId: string, now = new Date(), today = toBerlinDate(now)): Promise<void> {
  const [a] = await db.select().from(sprechtagAppointments).where(eq(sprechtagAppointments.id, appointmentId));
  if (!a) return;
  const e = (await getEvent(db, a.eventId))!;
  const byTeacher = a.teacherId === perms.userId;
  const byManage = hasPermission(perms, MANAGE);
  // G4D-C05: absagen darf die Familie nur, solange sie für das Kind handelt – `booked_by` allein reicht nicht mehr
  const byFamily = await actsFor(db, perms, a.studentId);
  if (!byTeacher && !byManage && !byFamily) throw new ForbiddenError("sprechtag.cancel");
  if (today > e.date) throw new ValidationError({ slot: "Der Sprechtag ist vorbei" });
  await db.delete(sprechtagAppointments).where(eq(sprechtagAppointments.id, a.id));
  const [teacher] = await db.select({ name: users.name }).from(users).where(eq(users.id, a.teacherId));
  const [student] = await db.select({ name: users.name }).from(users).where(eq(users.id, a.studentId));
  const when = `${formatEventDay(e.date)}, ${a.slot} Uhr`;
  if (byTeacher || (byManage && !byFamily)) {
    const family = new Set(await familyRecipients(db, [a.studentId]));
    family.delete(perms.userId);
    await notify(db, [...family], {
      moduleId: "sprechtag",
      title: `Termin abgesagt: ${teacher?.name ?? "Lehrkraft"}, ${when}`,
      body: `Der Gesprächstermin für ${student?.name ?? "Ihr Kind"} ist entfallen. Sie können einen neuen Termin buchen.`,
      href: "/sprechtag/buchen",
    });
  }
  if (!byTeacher) {
    await notify(db, [a.teacherId], {
      moduleId: "sprechtag",
      title: `Termin abgesagt: ${student?.name ?? "Schüler:in"}, ${when}`,
      body: "Die Zeit ist wieder frei.",
      href: `/sprechtag/${e.id}`,
    });
  }
  await audit(db, perms.userId, "sprechtag.cancel", a.eventId, { slot: a.slot, by: byTeacher ? "lehrkraft" : byFamily ? "familie" : "verwaltung" });
}

// ------------------------------------------------------------------ Vorschlag „hintereinander“

export interface SuggestionItem extends BookingInput {
  teacherName: string;
  roomName: string | null;
}

/**
 * Vorschlag für eine Familie: die gewünschten Gespräche (Lehrkraft × Kind) möglichst ohne Lücke hintereinander, um
 * eigene Termine herum. null, wenn nicht alle unterzubringen sind.
 */
export async function suggestForFamily(db: Db, perms: PermissionSet, e: SprechtagEvent, wishes: readonly { teacherId: string; studentId: string }[]): Promise<SuggestionItem[] | null> {
  const students = [...new Set(wishes.map((w) => w.studentId))];
  for (const s of students) if (!(await actsFor(db, perms, s))) throw new ForbiddenError("sprechtag.book");
  const boards = new Map((await teacherBoards(db, e)).map((b) => [b.teacherId, b]));
  const mine = await db
    .select({ slot: sprechtagAppointments.slot })
    .from(sprechtagAppointments)
    .where(and(eq(sprechtagAppointments.eventId, e.id), or(eq(sprechtagAppointments.bookedBy, perms.userId), inArray(sprechtagAppointments.studentId, students.length ? students : ["-"]))));
  const requests = wishes
    .filter((w) => boards.has(w.teacherId))
    .map((w) => ({ key: `${w.teacherId}:${w.studentId}`, free: new Set(boards.get(w.teacherId)!.free) }));
  if (requests.length !== wishes.length) return null;
  const plan = suggestSequence(
    slotsFor(e),
    requests,
    new Set(mine.map((m) => m.slot)),
  );
  if (!plan) return null;
  return plan.map((p) => {
    const [teacherId, studentId] = p.key.split(":") as [string, string];
    const b = boards.get(teacherId)!;
    return { teacherId, studentId, slot: p.slot, teacherName: b.name, roomName: b.roomName };
  });
}

// ------------------------------------------------------------------ Gesprächswünsche

export async function invitationsFor(db: Db, eventId: string, studentIds: readonly string[]) {
  if (studentIds.length === 0) return [];
  return db
    .select({ teacherId: sprechtagInvitations.teacherId, studentId: sprechtagInvitations.studentId, teacherName: users.name, createdAt: sprechtagInvitations.createdAt })
    .from(sprechtagInvitations)
    .innerJoin(users, eq(users.id, sprechtagInvitations.teacherId))
    .where(and(eq(sprechtagInvitations.eventId, eventId), inArray(sprechtagInvitations.studentId, [...studentIds])));
}

