// Stammdaten Räume: Art, Gebäude/Etage, Kapazität, barrierefrei, aktiv. Ausstattung seit RS-05 im Katalog (raumausstattung.ts),
// gepflegt im Raumsteckbrief.
import { and, asc, count, eq, getTableColumns, ilike, or, sql, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { ROOM_KINDS, bookingResources, bookings, buildingFloors, buildings, exams, rooms, timetableLessons, timetableSubstitutions, type RoomKind } from "@/core/db/schema";
import { resolvePlace } from "./gebaeude-etagen";
import { ValidationError } from "./users";

export type Room = typeof rooms.$inferSelect;

export async function listRooms(db: Db, f: { q?: string; kind?: RoomKind; activeOnly?: boolean } = {}): Promise<Room[]> {
  const where: SQL[] = [];
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(rooms.id, like), ilike(rooms.name, like), ilike(rooms.building, like))!);
  }
  if (f.kind) where.push(eq(rooms.kind, f.kind));
  if (f.activeOnly) where.push(eq(rooms.active, true));
  // RS-10: nach der Reihenfolge der Gebäude und Etagen (Stammdaten), Räume ohne Angabe am Ende
  return db
    .select(getTableColumns(rooms))
    .from(rooms)
    .leftJoin(buildings, eq(buildings.id, rooms.buildingId))
    .leftJoin(buildingFloors, eq(buildingFloors.id, rooms.floorId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${buildings.sortOrder} asc nulls last`, asc(buildings.name), sql`${buildingFloors.sortOrder} asc nulls first`, asc(rooms.id));
}

export async function getRoom(db: Db, id: string): Promise<Room | null> {
  const [r] = await db.select().from(rooms).where(eq(rooms.id, id));
  return r ?? null;
}

/** Wie oft ein Raum in Stundenplan, Vertretungen, Klausuren und Buchungen vorkommt (dann nicht löschbar). */
export async function roomUsage(db: Db, id?: string): Promise<Map<string, number>> {
  const parts = await Promise.all([
    db.select({ id: timetableLessons.roomId, n: count() }).from(timetableLessons).where(id ? eq(timetableLessons.roomId, id) : undefined).groupBy(timetableLessons.roomId),
    db.select({ id: timetableSubstitutions.roomId, n: count() }).from(timetableSubstitutions).where(id ? eq(timetableSubstitutions.roomId, id) : undefined).groupBy(timetableSubstitutions.roomId),
    db.select({ id: exams.roomId, n: count() }).from(exams).where(id ? eq(exams.roomId, id) : undefined).groupBy(exams.roomId),
    db
      .select({ id: bookingResources.roomId, n: count() })
      .from(bookings)
      .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
      .where(id ? eq(bookingResources.roomId, id) : undefined)
      .groupBy(bookingResources.roomId),
  ]);
  const out = new Map<string, number>();
  for (const r of parts.flat()) if (r.id) out.set(r.id, (out.get(r.id) ?? 0) + r.n);
  return out;
}

export interface RoomInput {
  code: string;
  name: string;
  kind: string;
  /** RS-10: Gebäude aus den Stammdaten (bei gesetzter Etage egal – dann gilt deren Gebäude) */
  buildingId?: string | null;
  floorId?: string | null;
  /** leer = unbekannt */
  capacity?: string | number | null;
  accessible: boolean;
  active: boolean;
}

const CODE_RE = /^[\p{L}\p{N}.\-]{1,10}$/u;

async function validate(db: Db, input: RoomInput, exceptId?: string) {
  const fe: Record<string, string> = {};
  const code = input.code.trim();
  if (!CODE_RE.test(code)) fe.code = "Kürzel: 1–10 Zeichen, Buchstaben, Ziffern, Punkt oder Bindestrich";
  else if (code.toLowerCase() !== exceptId?.toLowerCase()) {
    const [dup] = await db.select({ id: rooms.id }).from(rooms).where(ilike(rooms.id, code));
    if (dup) fe.code = "Kürzel schon vergeben";
  }
  if (!input.name.trim()) fe.name = "Name angeben";
  if (!(ROOM_KINDS as readonly string[]).includes(input.kind)) fe.kind = "Raumart wählen";
  const capRaw = input.capacity === null || input.capacity === undefined ? "" : String(input.capacity).trim();
  const capacity = capRaw === "" ? null : Number(capRaw);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 2000)) fe.capacity = "Kapazität 1–2000 oder leer";
  let place: Awaited<ReturnType<typeof resolvePlace>> = { buildingId: null, floorId: null, building: null, floor: null };
  try {
    place = await resolvePlace(db, { buildingId: input.buildingId, floorId: input.floorId });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    Object.assign(fe, err.fieldErrors);
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    id: code,
    name: input.name.trim(),
    kind: input.kind as RoomKind,
    // Anzeigekopie aus den Stammdaten (RS-10)
    building: place.building,
    floor: place.floor,
    buildingId: place.buildingId,
    floorId: place.floorId,
    capacity,
    accessible: input.accessible,
    active: input.active,
  };
}

export async function createRoom(db: Db, actorId: string, input: RoomInput): Promise<string> {
  const values = await validate(db, input);
  await db.insert(rooms).values(values);
  await audit(db, actorId, "verwaltung.room.create", values.id, { name: values.name });
  return values.id;
}

/** Ändert einen Raum; ein neues Kürzel wird in Stundenplan, Vertretungen, Klausuren und Buchungen mitgezogen. */
export async function updateRoom(db: Db, actorId: string, id: string, input: RoomInput): Promise<string> {
  const values = await validate(db, input, id);
  await db.update(rooms).set(values).where(eq(rooms.id, id));
  await audit(db, actorId, "verwaltung.room.update", values.id, { renamedFrom: values.id !== id ? id : undefined });
  return values.id;
}

/** Legt einen Raum still (inaktiv) bzw. nimmt ihn wieder in Betrieb; Stundenplan-Verlauf bleibt erhalten. */
export async function setRoomActive(db: Db, actorId: string, id: string, active: boolean): Promise<void> {
  const room = await getRoom(db, id);
  if (!room) throw new ValidationError({ code: `Raum ${id} gibt es nicht` });
  if (room.active === active) return;
  await db.update(rooms).set({ active }).where(eq(rooms.id, id));
  await audit(db, actorId, active ? "verwaltung.room.activate" : "verwaltung.room.deactivate", id, {});
}

export async function deleteRoom(db: Db, actorId: string, id: string): Promise<void> {
  const used = (await roomUsage(db, id)).get(id) ?? 0;
  if (used) throw new ValidationError({ code: `Raum ${id} ist noch ${used}× verplant – stattdessen auf „inaktiv“ setzen` });
  await db.delete(rooms).where(eq(rooms.id, id));
  await audit(db, actorId, "verwaltung.room.delete", id, {});
}
