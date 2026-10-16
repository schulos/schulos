// Buchungen: Räume und Geräte je Tag und Stunde – Konflikte mit anderen Buchungen und (bei Räumen) dem Stundenplan.
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { bookingResources, bookings, groups, periods, rooms, users } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { dayOffLabel, loadSchoolCalendar, type DayOff } from "@/core/school/calendar";
import { addDays, weekdayMon0 } from "@/core/time";
import { roomLessonAt } from "@/modules/stundenplan/vertretung";
import { ValidationError } from "@/modules/verwaltung/users";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface BookingInput {
  resourceId: string;
  date: string;
  periodNr: number;
  groupId: string | null;
  note: string;
}

export async function listResources(db: Db, includeInactive = false) {
  const rows = await db
    .select()
    .from(bookingResources)
    .where(includeInactive ? undefined : eq(bookingResources.active, true))
    .orderBy(asc(bookingResources.kind), asc(bookingResources.name));
  return rows;
}

export type SlotState =
  | { kind: "free" }
  | { kind: "lesson"; label: string }
  /** Feiertag oder Ferien: Schule geschlossen */
  | { kind: "closed"; label: string }
  | { kind: "booked"; bookingId: string; byId: string | null; byName: string | null; groupName: string | null; note: string | null };

/** Belegung einer Ressource für eine Woche: Schlüssel „YYYY-MM-DD:Stunde“. */
export async function resourceWeek(db: Db, resourceId: string, monday: string): Promise<Map<string, SlotState>> {
  const [res] = await db.select().from(bookingResources).where(eq(bookingResources.id, resourceId));
  const out = new Map<string, SlotState>();
  if (!res) return out;
  const friday = addDays(monday, 4);
  const [booked, ps] = await Promise.all([
    db
      .select({ b: bookings, byName: users.name, groupName: groups.name })
      .from(bookings)
      .leftJoin(users, eq(users.id, bookings.bookedBy))
      .leftJoin(groups, eq(groups.id, bookings.groupId))
      .where(and(eq(bookings.resourceId, resourceId), gte(bookings.date, monday), lte(bookings.date, friday))),
    db.select({ nr: periods.nr }).from(periods),
  ]);
  // Feiertage und Ferien sind gesperrt; unterrichtsfreie Tage (z. B. pädagogischer Tag) bleiben buchbar
  const cal = await loadSchoolCalendar(db);
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i);
    const off = cal.dayOff(d);
    if (off && closesBooking(off)) for (const p of ps) out.set(`${d}:${p.nr}`, { kind: "closed", label: dayOffLabel(off) });
  }
  for (const x of booked) {
    out.set(`${x.b.date}:${x.b.periodNr}`, { kind: "booked", bookingId: x.b.id, byId: x.b.bookedBy, byName: x.byName, groupName: x.groupName, note: x.b.note });
  }
  if (res.roomId) {
    for (let i = 0; i < 5; i++) {
      const d = addDays(monday, i);
      for (const p of ps) {
        const key = `${d}:${p.nr}`;
        if (out.has(key) || cal.dayOff(d)) continue;
        const lesson = await roomLessonAt(db, res.roomId, d, p.nr);
        if (lesson) out.set(key, { kind: "lesson", label: `${lesson.subjectName} · ${lesson.groupName}` });
      }
    }
  }
  return out;
}

const closesBooking = (off: DayOff) => off.kind === "feiertag" || off.kind === "ferien";

export async function book(db: Db, viewer: PermissionSet, input: BookingInput, todayYmd: string): Promise<string> {
  if (!hasPermission(viewer, "buchungen.book")) throw new ForbiddenError("buchungen.book");
  const fe: Record<string, string> = {};
  const [res] = await db.select().from(bookingResources).where(eq(bookingResources.id, input.resourceId));
  if (!res || !res.active) fe.resourceId = "Diese Ressource ist nicht buchbar";
  if (!YMD.test(input.date)) fe.date = "Datum angeben";
  else if (input.date < todayYmd) fe.date = "Buchungen in der Vergangenheit sind nicht möglich";
  else if (weekdayMon0(input.date) > 4) fe.date = "Am Wochenende wird nicht gebucht";
  else {
    const off = (await loadSchoolCalendar(db)).dayOff(input.date);
    if (off && closesBooking(off)) fe.date = `Schule geschlossen: ${dayOffLabel(off)}`;
  }
  const [p] = await db.select().from(periods).where(eq(periods.nr, input.periodNr));
  if (!p) fe.periodNr = "Stunde wählen";
  if (input.note.length > 200) fe.note = "Notiz bitte kürzer fassen";
  if (input.groupId) {
    const [g] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId));
    if (!g) fe.groupId = "Gruppe gibt es nicht";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);

  const [taken] = await db
    .select({ id: bookings.id, byName: users.name })
    .from(bookings)
    .leftJoin(users, eq(users.id, bookings.bookedBy))
    .where(and(eq(bookings.resourceId, input.resourceId), eq(bookings.date, input.date), eq(bookings.periodNr, input.periodNr)));
  if (taken) throw new ValidationError({ periodNr: `Schon gebucht${taken.byName ? ` von ${taken.byName}` : ""}` });
  if (res!.roomId) {
    const lesson = await roomLessonAt(db, res!.roomId, input.date, input.periodNr);
    if (lesson) throw new ValidationError({ periodNr: `Im Raum ist Unterricht (${lesson.subjectName} · ${lesson.groupName})` });
  }
  const [row] = await db
    .insert(bookings)
    .values({ resourceId: input.resourceId, date: input.date, periodNr: input.periodNr, bookedBy: viewer.userId, groupId: input.groupId, note: input.note.trim() || null })
    .returning({ id: bookings.id });
  await audit(db, viewer.userId, "buchungen.book", res!.name, { date: input.date, period: input.periodNr });
  return row!.id;
}

/** Stornieren: eigene Buchung oder mit „verwalten“. */
export async function cancelBooking(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!b) return;
  if (b.bookedBy !== viewer.userId && !hasPermission(viewer, "buchungen.manage")) throw new ForbiddenError("buchungen.manage");
  await db.delete(bookings).where(eq(bookings.id, id));
  await audit(db, viewer.userId, "buchungen.cancel", b.resourceId, { date: b.date, period: b.periodNr });
}

/** Eigene kommende Buchungen */
export async function myBookings(db: Db, userId: string, fromYmd: string) {
  return db
    .select({ id: bookings.id, date: bookings.date, periodNr: bookings.periodNr, resourceName: bookingResources.name, resourceId: bookings.resourceId, note: bookings.note })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .where(and(eq(bookings.bookedBy, userId), gte(bookings.date, fromYmd)))
    .orderBy(asc(bookings.date), asc(bookings.periodNr));
}

/** Ressourcen verwalten: Gerät anlegen, Raum buchbar machen, an/aus. */
export async function addResource(db: Db, viewer: PermissionSet, input: { kind: "room" | "device"; roomId?: string; name?: string; description?: string }): Promise<string> {
  if (!hasPermission(viewer, "buchungen.manage")) throw new ForbiddenError("buchungen.manage");
  if (input.kind === "room") {
    const [r] = input.roomId ? await db.select().from(rooms).where(eq(rooms.id, input.roomId)) : [];
    if (!r) throw new ValidationError({ roomId: "Raum wählen" });
    const [exists] = await db.select().from(bookingResources).where(eq(bookingResources.roomId, r.id));
    if (exists) throw new ValidationError({ roomId: "Raum ist schon buchbar" });
    const [row] = await db
      .insert(bookingResources)
      .values({ kind: "room", roomId: r.id, name: r.id === r.name ? `Raum ${r.id}` : `${r.name} (${r.id})` })
      .returning({ id: bookingResources.id });
    return row!.id;
  }
  const name = input.name?.trim() ?? "";
  if (!name) throw new ValidationError({ name: "Name angeben" });
  const [row] = await db.insert(bookingResources).values({ kind: "device", name, description: input.description?.trim() || null }).returning({ id: bookingResources.id });
  return row!.id;
}

export async function setResourceActive(db: Db, viewer: PermissionSet, id: string, active: boolean): Promise<void> {
  if (!hasPermission(viewer, "buchungen.manage")) throw new ForbiddenError("buchungen.manage");
  await db.update(bookingResources).set({ active }).where(eq(bookingResources.id, id));
}

/** Räume, die noch nicht buchbar sind (Auswahl beim Hinzufügen) */
export async function roomsWithoutResource(db: Db) {
  const taken = (await db.select({ roomId: bookingResources.roomId }).from(bookingResources)).map((r) => r.roomId).filter((x): x is string => !!x);
  const all = await db.select().from(rooms).where(eq(rooms.active, true)).orderBy(asc(rooms.id));
  return all.filter((r) => !taken.includes(r.id));
}

/**
 * Wer darf die Belegung sehen? Buchende (`buchungen.book`) – und lesend die Hausmeisterei (`gebaeude.manage`, Q5-08b), wenn das
 * Modul Gebäude & Technik an ist: Aula/Sporthalle vorbereiten, Arbeiten ohne Störung planen. Buchen/Stornieren bleibt beim Recht.
 */
export function bookingAccess(viewer: PermissionSet, gebaeudeOn: boolean): "book" | "read" | null {
  if (hasPermission(viewer, "buchungen.book")) return "book";
  if (gebaeudeOn && hasPermission(viewer, "gebaeude.manage")) return "read";
  return null;
}

export interface DayBooking {
  id: string;
  periodNr: number;
  startsAt: string | null;
  resourceName: string;
  kind: "room" | "device";
  byName: string | null;
  groupName: string | null;
}

/** Buchungen eines Tages (Widget „Heute im Haus“), ohne Notiz; `kind` grenzt auf Räume bzw. Geräte ein. */
export async function bookingsOn(db: Db, date: string, kind?: "room" | "device"): Promise<DayBooking[]> {
  const rows = await db
    .select({
      id: bookings.id,
      periodNr: bookings.periodNr,
      startsAt: periods.startsAt,
      resourceName: bookingResources.name,
      kind: bookingResources.kind,
      byName: users.name,
      groupName: groups.name,
    })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .leftJoin(periods, eq(periods.nr, bookings.periodNr))
    .leftJoin(users, eq(users.id, bookings.bookedBy))
    .leftJoin(groups, eq(groups.id, bookings.groupId))
    .where(and(eq(bookings.date, date), kind ? eq(bookingResources.kind, kind) : undefined))
    .orderBy(asc(bookings.periodNr), asc(bookingResources.name));
  return rows;
}
