// RS-10 (docs/RAUMSTECKBRIEF.md): Gebäude und Etagen als Stammdaten statt Freitext an `rooms`. Reihenfolge für Sortierung und
// Filter (Raumfinder, Stammdaten-Raumliste); pflegen nur mit `verwaltung.school`. `rooms.building`/`rooms.floor` bleiben als
// Anzeigekopie (Mängel, Prüfungen, Raumsuche lesen sie weiter) – geschrieben nur hier und in `rooms.ts`.
import { and, count, eq, isNotNull, max, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { buildingFloors, buildings, rooms, type Building, type BuildingFloor } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "./users";

export const PLACE_NAME_MAX = 60;
export const BUILDINGS_MAX = 50;
export const FLOORS_PER_BUILDING_MAX = 30;
const SORT_MAX = 99_999;

/** Gebäude und Etagen anlegen, ändern, löschen: Stammdaten-Recht. */
export function canManagePlaces(viewer: PermissionSet): boolean {
  return hasPermission(viewer, "verwaltung.school");
}

function requireManage(viewer: PermissionSet) {
  if (!canManagePlaces(viewer)) throw new ForbiddenError("verwaltung.school");
}

/** Rein: Name wie gespeichert – Leerraum zusammengefasst und an den Rändern entfernt. */
export function placeName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export interface PlaceInput {
  name: string;
  /** leer = ans Ende */
  sortOrder?: string | number | null;
}

function readInput(input: PlaceInput): { name: string; sortOrder: number | null } {
  const fe: Record<string, string> = {};
  const name = placeName(input.name);
  if (!name) fe.name = "Name angeben";
  else if (name.length > PLACE_NAME_MAX) fe.name = `Name höchstens ${PLACE_NAME_MAX} Zeichen`;
  const raw = input.sortOrder === null || input.sortOrder === undefined ? "" : String(input.sortOrder).trim();
  const sortOrder = raw === "" ? null : Number(raw);
  if (sortOrder !== null && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > SORT_MAX)) fe.sortOrder = `Reihenfolge 0–${SORT_MAX} oder leer`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { name, sortOrder };
}

export type FloorWithRooms = BuildingFloor & { rooms: number };
export type BuildingWithFloors = Building & { floors: FloorWithRooms[]; rooms: number };

/** Rein: Reihenfolge, dann Name (Vergleich in JS, unabhängig von der Collation der DB). */
export function bySortOrder<T extends { sortOrder: number; name: string }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "de", { numeric: true });
}

/** Alle Gebäude mit ihren Etagen in Reihenfolge, je mit der Zahl zugeordneter Räume (auch stillgelegter). Lesen: alle. */
export async function listBuildings(db: Db): Promise<BuildingWithFloors[]> {
  const [bs, fs, byBuilding, byFloor] = await Promise.all([
    db.select().from(buildings),
    db.select().from(buildingFloors),
    db.select({ id: rooms.buildingId, n: count() }).from(rooms).where(isNotNull(rooms.buildingId)).groupBy(rooms.buildingId),
    db.select({ id: rooms.floorId, n: count() }).from(rooms).where(isNotNull(rooms.floorId)).groupBy(rooms.floorId),
  ]);
  const nb = new Map(byBuilding.map((r) => [r.id, r.n]));
  const nf = new Map(byFloor.map((r) => [r.id, r.n]));
  return bs.sort(bySortOrder).map((b) => ({
    ...b,
    rooms: nb.get(b.id) ?? 0,
    floors: fs
      .filter((f) => f.buildingId === b.id)
      .sort(bySortOrder)
      .map((f) => ({ ...f, rooms: nf.get(f.id) ?? 0 })),
  }));
}

/** Position je Gebäude/Etage für Sortierungen (Index in der Reihenfolge; unbekannt = ans Ende). */
export async function placeRanks(db: Db): Promise<{ building: Map<string, number>; floor: Map<string, number> }> {
  const list = await listBuildings(db);
  return {
    building: new Map(list.map((b, i) => [b.id, i])),
    floor: new Map(list.flatMap((b) => b.floors.map((f, i) => [f.id, i] as const))),
  };
}

async function nameTaken(db: Db, name: string, opts: { buildingId?: string; exceptId?: string }): Promise<boolean> {
  const rows =
    opts.buildingId === undefined
      ? await db.select({ id: buildings.id }).from(buildings).where(sql`lower(${buildings.name}) = lower(${name})`)
      : await db
          .select({ id: buildingFloors.id })
          .from(buildingFloors)
          .where(and(eq(buildingFloors.buildingId, opts.buildingId), sql`lower(${buildingFloors.name}) = lower(${name})`));
  return rows.some((r) => r.id !== opts.exceptId);
}

async function nextSort(db: Db, buildingId?: string): Promise<number> {
  const [row] =
    buildingId === undefined
      ? await db.select({ m: max(buildings.sortOrder) }).from(buildings)
      : await db.select({ m: max(buildingFloors.sortOrder) }).from(buildingFloors).where(eq(buildingFloors.buildingId, buildingId));
  return Math.min(SORT_MAX, (row?.m ?? 0) + 10);
}

export async function createBuilding(db: Db, viewer: PermissionSet, input: PlaceInput): Promise<string> {
  requireManage(viewer);
  const v = readInput(input);
  if (await nameTaken(db, v.name, {})) throw new ValidationError({ name: "Dieses Gebäude gibt es schon" });
  const n = (await db.select({ n: count() }).from(buildings))[0]?.n ?? 0;
  if (n >= BUILDINGS_MAX) throw new ValidationError({ name: `Höchstens ${BUILDINGS_MAX} Gebäude` });
  const [row] = await db
    .insert(buildings)
    .values({ name: v.name, sortOrder: v.sortOrder ?? (await nextSort(db)) })
    .returning({ id: buildings.id });
  await audit(db, viewer.userId, "verwaltung.room.building.create", row!.id, { name: v.name });
  return row!.id;
}

/** Umbenennen zieht die Anzeigekopie `rooms.building` aller zugeordneten Räume mit. */
export async function updateBuilding(db: Db, viewer: PermissionSet, id: string, input: PlaceInput): Promise<void> {
  requireManage(viewer);
  const v = readInput(input);
  const [old] = await db.select().from(buildings).where(eq(buildings.id, id));
  if (!old) throw new ValidationError({ name: "Gebäude nicht gefunden" });
  if (await nameTaken(db, v.name, { exceptId: id })) throw new ValidationError({ name: "Dieses Gebäude gibt es schon" });
  await db.transaction(async (tx) => {
    await tx
      .update(buildings)
      .set({ name: v.name, sortOrder: v.sortOrder ?? old.sortOrder })
      .where(eq(buildings.id, id));
    if (v.name !== old.name) await tx.update(rooms).set({ building: v.name }).where(eq(rooms.buildingId, id));
  });
  await audit(db, viewer.userId, "verwaltung.room.building.update", id, { name: v.name, renamedFrom: v.name !== old.name ? old.name : undefined });
}

/** Nur ohne zugeordnete Räume (auch stillgelegte); die Etagen gehen mit. */
export async function deleteBuilding(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  requireManage(viewer);
  const [old] = await db.select().from(buildings).where(eq(buildings.id, id));
  if (!old) return;
  const n = (await db.select({ n: count() }).from(rooms).where(eq(rooms.buildingId, id)))[0]?.n ?? 0;
  if (n > 0) throw new ValidationError({ name: `Noch ${n} ${n === 1 ? "Raum" : "Räume"} in „${old.name}“ – erst umziehen` });
  await db.delete(buildings).where(eq(buildings.id, id));
  await audit(db, viewer.userId, "verwaltung.room.building.delete", id, { name: old.name });
}

export async function createFloor(db: Db, viewer: PermissionSet, buildingId: string, input: PlaceInput): Promise<string> {
  requireManage(viewer);
  const v = readInput(input);
  const [b] = await db.select({ id: buildings.id }).from(buildings).where(eq(buildings.id, buildingId));
  if (!b) throw new ValidationError({ name: "Gebäude nicht gefunden" });
  if (await nameTaken(db, v.name, { buildingId })) throw new ValidationError({ name: "Diese Etage gibt es in dem Gebäude schon" });
  const n = (await db.select({ n: count() }).from(buildingFloors).where(eq(buildingFloors.buildingId, buildingId)))[0]?.n ?? 0;
  if (n >= FLOORS_PER_BUILDING_MAX) throw new ValidationError({ name: `Höchstens ${FLOORS_PER_BUILDING_MAX} Etagen je Gebäude` });
  const [row] = await db
    .insert(buildingFloors)
    .values({ buildingId, name: v.name, sortOrder: v.sortOrder ?? (await nextSort(db, buildingId)) })
    .returning({ id: buildingFloors.id });
  await audit(db, viewer.userId, "verwaltung.room.floor.create", row!.id, { name: v.name, buildingId });
  return row!.id;
}

/** Umbenennen zieht die Anzeigekopie `rooms.floor` mit. */
export async function updateFloor(db: Db, viewer: PermissionSet, id: string, input: PlaceInput): Promise<void> {
  requireManage(viewer);
  const v = readInput(input);
  const [old] = await db.select().from(buildingFloors).where(eq(buildingFloors.id, id));
  if (!old) throw new ValidationError({ name: "Etage nicht gefunden" });
  if (await nameTaken(db, v.name, { buildingId: old.buildingId, exceptId: id })) throw new ValidationError({ name: "Diese Etage gibt es in dem Gebäude schon" });
  await db.transaction(async (tx) => {
    await tx
      .update(buildingFloors)
      .set({ name: v.name, sortOrder: v.sortOrder ?? old.sortOrder })
      .where(eq(buildingFloors.id, id));
    if (v.name !== old.name) await tx.update(rooms).set({ floor: v.name }).where(eq(rooms.floorId, id));
  });
  await audit(db, viewer.userId, "verwaltung.room.floor.update", id, { name: v.name, renamedFrom: v.name !== old.name ? old.name : undefined });
}

export async function deleteFloor(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  requireManage(viewer);
  const [old] = await db.select().from(buildingFloors).where(eq(buildingFloors.id, id));
  if (!old) return;
  const n = (await db.select({ n: count() }).from(rooms).where(eq(rooms.floorId, id)))[0]?.n ?? 0;
  if (n > 0) throw new ValidationError({ name: `Noch ${n} ${n === 1 ? "Raum" : "Räume"} auf „${old.name}“ – erst umziehen` });
  await db.delete(buildingFloors).where(eq(buildingFloors.id, id));
  await audit(db, viewer.userId, "verwaltung.room.floor.delete", id, { name: old.name, buildingId: old.buildingId });
}

export interface ResolvedPlace {
  buildingId: string | null;
  floorId: string | null;
  building: string | null;
  floor: string | null;
}

/**
 * Ort eines Raums aus der Auswahl: Etage (dann gilt ihr Gebäude) oder nur Gebäude oder nichts. Liefert die IDs und die
 * Namen für die Anzeigekopie; unbekannte IDs bzw. eine Etage aus einem anderen Gebäude → `ValidationError` (Feld `place`).
 */
export async function resolvePlace(db: Db, sel: { buildingId?: string | null; floorId?: string | null }): Promise<ResolvedPlace> {
  if (sel.floorId) {
    const [f] = await db
      .select({ id: buildingFloors.id, name: buildingFloors.name, buildingId: buildings.id, building: buildings.name })
      .from(buildingFloors)
      .innerJoin(buildings, eq(buildings.id, buildingFloors.buildingId))
      .where(eq(buildingFloors.id, sel.floorId));
    if (!f) throw new ValidationError({ place: "Etage gibt es nicht" });
    if (sel.buildingId && sel.buildingId !== f.buildingId) throw new ValidationError({ place: "Etage gehört zu einem anderen Gebäude" });
    return { buildingId: f.buildingId, floorId: f.id, building: f.building, floor: f.name };
  }
  if (sel.buildingId) {
    const [b] = await db.select().from(buildings).where(eq(buildings.id, sel.buildingId));
    if (!b) throw new ValidationError({ place: "Gebäude gibt es nicht" });
    return { buildingId: b.id, floorId: null, building: b.name, floor: null };
  }
  return { buildingId: null, floorId: null, building: null, floor: null };
}

/** Rein: Auswahlwert im Raumformular – `f:<etage>`, `b:<gebäude>` oder leer. */
export function parsePlaceValue(v: string): { buildingId: string | null; floorId: string | null } {
  if (v.startsWith("f:") && v.length > 2) return { buildingId: null, floorId: v.slice(2) };
  if (v.startsWith("b:") && v.length > 2) return { buildingId: v.slice(2), floorId: null };
  return { buildingId: null, floorId: null };
}

export const placeValue = (r: { buildingId: string | null; floorId: string | null }) => (r.floorId ? `f:${r.floorId}` : r.buildingId ? `b:${r.buildingId}` : "");

/**
 * Gebäude/Etage per Name holen oder anlegen (ohne Rechteprüfung, ohne Audit) – für den Demo-Seed. Neue Einträge kommen ans
 * Ende der Reihenfolge, die Reihenfolge der Aufrufe ergibt also die Sortierung.
 */
export async function ensurePlace(db: Db, building: string, floor?: string | null): Promise<{ buildingId: string; floorId: string | null }> {
  const bName = placeName(building);
  let [b] = await db.select({ id: buildings.id }).from(buildings).where(sql`lower(${buildings.name}) = lower(${bName})`);
  if (!b) [b] = await db.insert(buildings).values({ name: bName, sortOrder: await nextSort(db) }).returning({ id: buildings.id });
  const fName = placeName(floor ?? "");
  if (!fName) return { buildingId: b!.id, floorId: null };
  let [f] = await db
    .select({ id: buildingFloors.id })
    .from(buildingFloors)
    .where(and(eq(buildingFloors.buildingId, b!.id), sql`lower(${buildingFloors.name}) = lower(${fName})`));
  if (!f) [f] = await db.insert(buildingFloors).values({ buildingId: b!.id, name: fName, sortOrder: await nextSort(db, b!.id) }).returning({ id: buildingFloors.id });
  return { buildingId: b!.id, floorId: f!.id };
}

/** Für Auswahllisten: Gebäude in Reihenfolge mit ihren Etagen (nur ID und Name). */
export async function placeOptions(db: Db): Promise<{ id: string; name: string; floors: { id: string; name: string }[] }[]> {
  return (await listBuildings(db)).map((b) => ({ id: b.id, name: b.name, floors: b.floors.map((f) => ({ id: f.id, name: f.name })) }));
}
