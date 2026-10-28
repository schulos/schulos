// Raumplanung (P2b-16): Belegung aller Räume (Stundenplan + Vertretung + Buchung), Raumsuche mit Filtern, Auslastung.
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { bookingResources, bookings, groups, periods, rooms, subjects, timetableLessons, timetableRoomBlocks, timetableSubstitutions, users } from "@/core/db/schema";
import type { RoomBlockReason, RoomKind } from "@/core/db/schema";
import { dayOffLabel, loadSchoolCalendar } from "@/core/school/calendar";
import { addDays } from "@/core/time";
import { equipmentByRoom, type RoomEquipmentEntry } from "@/modules/verwaltung/raumausstattung";
import { coupledGroupLabel } from "./display";
import { lessonActiveOn } from "./service";
import { roomUse } from "./belegung";

export type Occupancy =
  /** `teacher`: Kürzel der haltenden Lehrkraft(en) – Vertretung statt Lehrkraft der Stunde (RS-02, nur für Beschäftigte anzeigen) */
  | { kind: "lesson"; label: string; moved?: boolean; teacher?: string }
  | { kind: "booking"; label: string }
  /** Raumsperrung (P2b-17) */
  | { kind: "blocked"; label: string }
  /** Feiertag/Ferien: Schule geschlossen */
  | { kind: "closed"; label: string };

export const ROOM_BLOCK_LABELS: Record<RoomBlockReason, string> = {
  renovierung: "Renovierung",
  pruefung: "Prüfung",
  veranstaltung: "Veranstaltung",
  defekt: "Defekt",
  sonstiges: "Sonstiges",
};

export interface RoomBlock {
  id: string;
  roomId: string;
  startsOn: string;
  endsOn: string;
  fromPeriod: number | null;
  toPeriod: number | null;
  reason: RoomBlockReason;
  note: string | null;
}

/** Sperrt `b` den Raum am Tag `date` in Stunde `periodNr`? */
export function blockCovers(b: Pick<RoomBlock, "startsOn" | "endsOn" | "fromPeriod" | "toPeriod">, date: string, periodNr: number): boolean {
  if (date < b.startsOn || date > b.endsOn) return false;
  return b.fromPeriod === null || b.toPeriod === null || (periodNr >= b.fromPeriod && periodNr <= b.toPeriod);
}

export function blockLabel(b: Pick<RoomBlock, "reason" | "note">): string {
  return `Gesperrt: ${ROOM_BLOCK_LABELS[b.reason]}${b.note ? ` (${b.note})` : ""}`;
}



export interface RoomInfo {
  id: string;
  name: string;
  kind: RoomKind;
  building: string | null;
  floor: string | null;
  capacity: number | null;
  /** RS-05: Ausstattung aus dem Katalog mit Menge */
  equipment: RoomEquipmentEntry[];
  accessible: boolean;
  active: boolean;
}

/** Belegung eines Tages: roomId → Stunde → was dort stattfindet. */
export type DayOccupancy = Map<string, Map<number, Occupancy>>;

interface OccLesson {
  id: string;
  roomId: string | null;
  periodNr: number;
  groupName: string;
  subjectName: string;
  couplingId: string | null;
  /** Kürzel der Lehrkraft der Stunde (RS-02) */
  teacherCode?: string | null;
}
interface OccChange {
  lessonId: string;
  kind: "cancel" | "substitute" | "room" | "move" | "merge";
  roomId: string | null;
  /** SP2-07 Verlegung: neue Stunde */
  targetPeriod?: number | null;
  /** Kürzel der Vertretungslehrkraft (RS-02) */
  substituteCode?: string | null;
}
interface OccBooking {
  roomId: string;
  periodNr: number;
  label: string;
}

/**
 * Rein: Belegung aus den Stunden des Tages, ihren Änderungen und den Buchungen.
 * Entfall gibt den Raum frei, eine Raumänderung belegt den neuen Raum; gekoppelte Gruppen im selben Raum stehen zusammen.
 */
export function occupancyFrom(lessons: OccLesson[], changes: OccChange[], booked: OccBooking[], blocked: { roomId: string; periodNr: number; label: string }[] = []): DayOccupancy {
  const out: DayOccupancy = new Map();
  const set = (roomId: string, p: number, o: Occupancy) => {
    if (!out.has(roomId)) out.set(roomId, new Map());
    const day = out.get(roomId)!;
    const prev = day.get(p);
    // mehrere Gruppen im selben Raum (Kopplung, Teamteaching): Gruppen zusammenfassen
    if (prev?.kind === "lesson" && o.kind === "lesson") {
      const teachers = [...new Set([prev.teacher, o.teacher].flatMap((t) => (t ? t.split(", ") : [])))];
      day.set(p, { ...prev, label: mergeLabels(prev.label, o.label), ...(teachers.length ? { teacher: teachers.join(", ") } : {}) });
      return;
    }
    if (!prev || prev.kind !== "lesson") day.set(p, o);
  };
  const changeOf = new Map(changes.map((c) => [c.lessonId, c]));
  for (const l of lessons) {
    const c = changeOf.get(l.id);
    // SP2-07: Entfall und Zusammenlegung geben den Raum frei, eine Verlegung belegt ihn in der neuen Stunde
    const use = roomUse(l, c && { kind: c.kind, substituteId: null, roomId: c.roomId, targetPeriod: c.targetPeriod ?? null });
    if (!use) continue;
    const teacher = c?.kind === "substitute" ? c.substituteCode : l.teacherCode;
    set(use.roomId, use.periodNr, {
      kind: "lesson",
      label: `${l.subjectName} · ${l.groupName}`,
      moved: Boolean((c?.roomId && c.roomId !== l.roomId) || c?.kind === "move"),
      ...(teacher ? { teacher } : {}),
    });
  }
  for (const b of booked) set(b.roomId, b.periodNr, { kind: "booking", label: b.label });
  // Sperrung geht vor: der Raum ist nicht nutzbar, auch wenn dort laut Plan Unterricht wäre
  for (const b of blocked) {
    if (!out.has(b.roomId)) out.set(b.roomId, new Map());
    out.get(b.roomId)!.set(b.periodNr, { kind: "blocked", label: b.label });
  }
  return out;
}

/** „Religion · Klasse 7a“ + „Religion · Klasse 7b“ → „Religion · 7a, 7b“ */
function mergeLabels(a: string, b: string): string {
  const [sa, ga] = a.split(" · ");
  const [sb, gb] = b.split(" · ");
  if (sa !== sb || !ga || !gb) return `${a} / ${b}`;
  return `${sa} · ${coupledGroupLabel([...ga.split(", "), gb])}`;
}

/** Belegung aller Räume an einem Tag. */
export async function occupancyOn(db: Db, date: string): Promise<{ occupancy: DayOccupancy; closed: string | null }> {
  const cal = await loadSchoolCalendar(db);
  const off = cal.dayOff(date);
  const closed = off && (off.kind === "feiertag" || off.kind === "ferien") ? dayOffLabel(off) : null;
  if (closed) return { occupancy: new Map(), closed };
  const [lessonRows, bookingRows, blockRows, periodRows] = await Promise.all([
    off
      ? Promise.resolve([])
      : db
          .select({ l: timetableLessons, groupName: groups.name, subjectName: subjects.name, teacherCode: users.shortCode })
          .from(timetableLessons)
          .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
          .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
          .leftJoin(users, eq(users.id, timetableLessons.teacherId)),
    db
      .select({ roomId: bookingResources.roomId, periodNr: bookings.periodNr, by: users.shortCode, byName: users.name, note: bookings.note, groupName: groups.name })
      .from(bookings)
      .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
      .leftJoin(users, eq(users.id, bookings.bookedBy))
      .leftJoin(groups, eq(groups.id, bookings.groupId))
      .where(eq(bookings.date, date)),
    db.select().from(timetableRoomBlocks).where(and(lte(timetableRoomBlocks.startsOn, date), gte(timetableRoomBlocks.endsOn, date))),
    db.select({ nr: periods.nr }).from(periods),
  ]);
  const active = lessonRows.filter((r) => lessonActiveOn(r.l, date));
  const changes = active.length
    ? await db
        .select({
          lessonId: timetableSubstitutions.lessonId,
          kind: timetableSubstitutions.kind,
          roomId: timetableSubstitutions.roomId,
          targetPeriod: timetableSubstitutions.targetPeriod,
          substituteCode: users.shortCode,
        })
        .from(timetableSubstitutions)
        .leftJoin(users, eq(users.id, timetableSubstitutions.substituteId))
        .where(and(eq(timetableSubstitutions.date, date), inArray(timetableSubstitutions.lessonId, active.map((r) => r.l.id))))
    : [];
  const occupancy = occupancyFrom(
    active.map((r) => ({ id: r.l.id, roomId: r.l.roomId, periodNr: r.l.periodNr, groupName: r.groupName, subjectName: r.subjectName, couplingId: r.l.couplingId, teacherCode: r.teacherCode })),
    changes,
    bookingRows
      .filter((b): b is typeof b & { roomId: string } => b.roomId !== null)
      .map((b) => ({ roomId: b.roomId, periodNr: b.periodNr, label: `Buchung ${b.by ?? b.byName ?? ""}${b.groupName ? ` · ${b.groupName}` : ""}`.trim() })),
    blockRows.flatMap((b) => periodRows.filter((p) => blockCovers(b, date, p.nr)).map((p) => ({ roomId: b.roomId, periodNr: p.nr, label: blockLabel(b) }))),
  );
  return { occupancy, closed: null };
}

export interface RoomFilter {
  /** Stunden, in denen der Raum durchgehend frei sein soll */
  periodNrs: number[];
  minCapacity?: number | null;
  kind?: RoomKind | null;
  /** Katalog-IDs der Ausstattung, die alle vorhanden sein muss (RS-05) */
  equipment?: string[];
  accessible?: boolean;
}

export interface RoomHit extends RoomInfo {
  /** Stunden des Tages, in denen der Raum sonst noch frei ist */
  freePeriods: number;
}

/**
 * Rein: freie, aktive Räume, die alle Filter erfüllen – sortiert nach Passung: kleinste ausreichende Kapazität zuerst
 * (große Räume bleiben für große Gruppen), dann Kürzel.
 */
export function searchRooms(roomList: RoomInfo[], occupancy: DayOccupancy, filter: RoomFilter, allPeriods: number[]): RoomHit[] {
  const wanted = filter.equipment ?? [];
  return roomList
    .filter((r) => r.active)
    .filter((r) => !filter.kind || r.kind === filter.kind)
    .filter((r) => !filter.minCapacity || (r.capacity !== null && r.capacity >= filter.minCapacity))
    .filter((r) => wanted.every((e) => r.equipment.some((x) => x.typeId === e)))
    .filter((r) => !filter.accessible || r.accessible)
    .filter((r) => filter.periodNrs.every((p) => !occupancy.get(r.id)?.has(p)))
    .map((r) => ({ ...r, freePeriods: allPeriods.filter((p) => !occupancy.get(r.id)?.has(p)).length }))
    .sort((a, b) => (a.capacity ?? 9999) - (b.capacity ?? 9999) || a.id.localeCompare(b.id, "de", { numeric: true }));
}

export async function listRooms(db: Db, includeInactive = false): Promise<RoomInfo[]> {
  const [rows, equipment] = await Promise.all([db.select().from(rooms).orderBy(asc(rooms.building), asc(rooms.id)), equipmentByRoom(db)]);
  return rows.filter((r) => includeInactive || r.active).map((r) => ({ ...r, equipment: equipment.get(r.id) ?? [] }));
}

export interface WeekUtilization {
  /** belegte Stunden je Raum in der Woche */
  used: Map<string, number>;
  /** mögliche Stunden der Woche (Schultage × Zeitraster) */
  capacity: number;
}

/** Auslastung je Raum in der Woche ab `monday`: belegte / mögliche Stunden (Feiertage und Ferien zählen nicht). */
export async function weekUtilization(db: Db, monday: string): Promise<WeekUtilization> {
  const ps = await db.select({ nr: periods.nr }).from(periods);
  const used = new Map<string, number>();
  let open = 0;
  for (let i = 0; i < 5; i++) {
    const { occupancy, closed } = await occupancyOn(db, addDays(monday, i));
    if (closed) continue;
    open++;
    for (const [roomId, day] of occupancy) used.set(roomId, (used.get(roomId) ?? 0) + day.size);
  }
  return { used, capacity: open * ps.length };
}

/** Buchbare Ressource je Raum (für den Link „buchen“). */
export async function bookableRooms(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: bookingResources.id, roomId: bookingResources.roomId })
    .from(bookingResources)
    .where(and(eq(bookingResources.active, true), eq(bookingResources.kind, "room")));
  return new Map(rows.filter((r) => r.roomId).map((r) => [r.roomId!, r.id]));
}
