// RS-08 (docs/RAUMSTECKBRIEF.md, Stufe 3): Raumlayouts – Raster wie im Sitzplan (bis 12 × 12) mit Elementen (Platz, Tisch,
// Pult, Tafel/Display, Tür, Fenster, Schrank, Waschbecken, Abzug), keine freie Zeichnung. Je Raum ein Standard-Layout plus
// optional weitere benannte (z. B. „Klausur“, Vorgabe RS-08). Sehen: nur Beschäftigte. Pflegen: `canEditRoomInfo` (Recht
// „Raumdaten pflegen“, `verwaltung.school` bzw. Raumverantwortliche für den eigenen Raum). Platz-Zellen zählen als Sitzplätze;
// der Abgleich mit `rooms.capacity` ist nur ein Hinweis, die Platzzahl ändert sich nie automatisch.
// RS-09: Sitzpläne übernehmen ein Layout als Kopie (`sitzplan/service.ts`), der Klausurplan liest die Prüfungsplätze.
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { roomLayouts, rooms, type RoomLayout } from "@/core/db/schema";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import {
  LAYOUTS_PER_ROOM_MAX,
  LAYOUT_NAME_MAX,
  LAYOUT_VARIANTS,
  examSeatKeys,
  layoutGridError,
  seatCount,
  type LayoutCells,
  type LayoutVariant,
} from "@/core/raumlayout-raster";
import { ROOM_DATA_PERMISSION, canEditRoomInfo, roomAudience } from "./raum-rechte";
import { ValidationError } from "./users";

/** Layouts sehen nur Beschäftigte (Sicht „personal“ des Steckbriefs). */
export function canViewLayouts(viewer: PermissionSet): boolean {
  return roomAudience(viewer) === "personal";
}

export interface RoomLayoutView extends RoomLayout {
  seats: number;
  examSeats: number;
}

const view = (l: RoomLayout): RoomLayoutView => ({ ...l, seats: seatCount(l.cells), examSeats: examSeatKeys(l.cells, l.variant).length });

/** Rein: Standard zuerst, dann nach Name. */
function order(list: RoomLayout[]): RoomLayout[] {
  return [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
}

/** Layouts eines Raums (Standard zuerst) – null für Schüler:innen und Eltern. */
export async function listRoomLayouts(db: Db, viewer: PermissionSet, roomId: string): Promise<RoomLayoutView[] | null> {
  if (!canViewLayouts(viewer)) return null;
  return order(await db.select().from(roomLayouts).where(eq(roomLayouts.roomId, roomId))).map(view);
}

/** Ein Layout – null, wenn es fehlt oder `viewer` keine Layouts sieht. */
export async function getRoomLayout(db: Db, viewer: PermissionSet, layoutId: string): Promise<RoomLayoutView | null> {
  if (!canViewLayouts(viewer) || !layoutId) return null;
  const [l] = await db.select().from(roomLayouts).where(eq(roomLayouts.id, layoutId));
  return l ? view(l) : null;
}

export interface RoomLayoutInput {
  name: string;
  variant: string;
  rows: number;
  cols: number;
  cells: LayoutCells;
}

async function editable(db: Db, viewer: PermissionSet, roomId: string): Promise<void> {
  if (!(await canEditRoomInfo(db, viewer, roomId))) throw new ForbiddenError(ROOM_DATA_PERMISSION);
}

/** Prüft die Eingaben (Name eindeutig je Raum, Variante, Raster); gibt die bereinigten Werte zurück. */
async function checkInput(db: Db, roomId: string, input: RoomLayoutInput, excludeId?: string) {
  const fe: Record<string, string> = {};
  const name = String(input.name ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!name) fe.name = "Namen angeben, z. B. „Standard“ oder „Klausur“";
  else if (name.length > LAYOUT_NAME_MAX) fe.name = `Name bitte kürzer (höchstens ${LAYOUT_NAME_MAX} Zeichen)`;
  else {
    const [dup] = await db
      .select({ id: roomLayouts.id })
      .from(roomLayouts)
      .where(and(eq(roomLayouts.roomId, roomId), sql`lower(${roomLayouts.name}) = lower(${name})`, excludeId ? ne(roomLayouts.id, excludeId) : undefined));
    if (dup) fe.name = `Ein Layout „${name}“ gibt es in diesem Raum schon`;
  }
  if (!(LAYOUT_VARIANTS as readonly string[]).includes(input.variant)) fe.variant = "Variante wählen";
  const grid = { rows: Number(input.rows), cols: Number(input.cols), cells: input.cells };
  const gerr = layoutGridError(grid);
  if (gerr) fe.layout = gerr;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { name, variant: input.variant as LayoutVariant, rows: grid.rows, cols: grid.cols, cells: { ...grid.cells } };
}

/** Legt ein Layout an; das erste Layout eines Raums wird Standard. Höchstens `LAYOUTS_PER_ROOM_MAX` je Raum. */
export async function createRoomLayout(db: Db, viewer: PermissionSet, roomId: string, input: RoomLayoutInput): Promise<string> {
  await editable(db, viewer, roomId);
  const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new ValidationError({ room: `Raum ${roomId} gibt es nicht` });
  const values = await checkInput(db, roomId, input);
  const id = await db.transaction(async (tx) => {
    // Sperre je Raum, damit Grenze und „erstes = Standard“ auch bei gleichzeitigem Anlegen halten
    await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).for("update");
    const existing = await tx.select({ id: roomLayouts.id }).from(roomLayouts).where(eq(roomLayouts.roomId, roomId));
    if (existing.length >= LAYOUTS_PER_ROOM_MAX) throw new ValidationError({ name: `Höchstens ${LAYOUTS_PER_ROOM_MAX} Layouts je Raum` });
    const [row] = await tx
      .insert(roomLayouts)
      .values({ roomId, ...values, isDefault: existing.length === 0 })
      .returning({ id: roomLayouts.id });
    await audit(tx, viewer.userId, "verwaltung.room.layout.create", roomId, { layoutId: row!.id, name: values.name, seats: seatCount(values.cells) });
    return row!.id;
  });
  return id;
}

async function ownLayout(db: Db, viewer: PermissionSet, layoutId: string): Promise<RoomLayout> {
  const [l] = await db.select().from(roomLayouts).where(eq(roomLayouts.id, layoutId));
  if (!l) throw new ForbiddenError(ROOM_DATA_PERMISSION);
  await editable(db, viewer, l.roomId);
  return l;
}

/** Speichert Name, Variante und Raster. Bestehende Sitzpläne (Kopien) ändern sich dadurch nicht. */
export async function updateRoomLayout(db: Db, viewer: PermissionSet, layoutId: string, input: RoomLayoutInput): Promise<void> {
  const l = await ownLayout(db, viewer, layoutId);
  const values = await checkInput(db, l.roomId, input, l.id);
  await db
    .update(roomLayouts)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(roomLayouts.id, l.id));
  await audit(db, viewer.userId, "verwaltung.room.layout.update", l.roomId, {
    layoutId: l.id,
    name: values.name,
    ...(values.name !== l.name ? { renamedFrom: l.name } : {}),
    seats: seatCount(values.cells),
  });
}

/** Macht ein Layout zum Standard des Raums. */
export async function setDefaultRoomLayout(db: Db, viewer: PermissionSet, layoutId: string): Promise<void> {
  const l = await ownLayout(db, viewer, layoutId);
  if (l.isDefault) return;
  await db.transaction(async (tx) => {
    await tx.update(roomLayouts).set({ isDefault: false }).where(eq(roomLayouts.roomId, l.roomId));
    await tx.update(roomLayouts).set({ isDefault: true }).where(eq(roomLayouts.id, l.id));
  });
  await audit(db, viewer.userId, "verwaltung.room.layout.default", l.roomId, { layoutId: l.id, name: l.name });
}

/** Löscht ein Layout; war es Standard, rückt das älteste übrige nach. Sitzpläne behalten ihre Kopie. */
export async function deleteRoomLayout(db: Db, viewer: PermissionSet, layoutId: string): Promise<void> {
  const l = await ownLayout(db, viewer, layoutId);
  await db.transaction(async (tx) => {
    await tx.delete(roomLayouts).where(eq(roomLayouts.id, l.id));
    if (l.isDefault) {
      const [next] = await tx.select({ id: roomLayouts.id }).from(roomLayouts).where(eq(roomLayouts.roomId, l.roomId)).orderBy(asc(roomLayouts.createdAt), asc(roomLayouts.id)).limit(1);
      if (next) await tx.update(roomLayouts).set({ isDefault: true }).where(eq(roomLayouts.id, next.id));
    }
  });
  await audit(db, viewer.userId, "verwaltung.room.layout.delete", l.roomId, { layoutId: l.id, name: l.name });
}

// ---------------------------------------------------------------- RS-09: Sitzplan und Klausurplan

export interface LayoutOption {
  id: string;
  roomId: string;
  roomName: string;
  name: string;
  isDefault: boolean;
  rows: number;
  cols: number;
  seats: number;
}

/** Layouts aktiver Räume für „Sitzplan aus Raumlayout“ (nur Beschäftigte), nach Raum und Standard zuerst. */
export async function layoutOptions(db: Db, viewer: PermissionSet, roomIds?: readonly string[]): Promise<LayoutOption[]> {
  if (!canViewLayouts(viewer) || (roomIds && roomIds.length === 0)) return [];
  const rows = await db
    .select({ l: roomLayouts, roomName: rooms.name })
    .from(roomLayouts)
    .innerJoin(rooms, eq(rooms.id, roomLayouts.roomId))
    .where(and(eq(rooms.active, true), roomIds ? inArray(roomLayouts.roomId, [...roomIds]) : undefined))
    .orderBy(asc(roomLayouts.roomId), desc(roomLayouts.isDefault));
  return rows
    .sort((a, b) => a.l.roomId.localeCompare(b.l.roomId, "de", { numeric: true }) || Number(b.l.isDefault) - Number(a.l.isDefault) || a.l.name.localeCompare(b.l.name, "de"))
    .map(({ l, roomName }) => ({ id: l.id, roomId: l.roomId, roomName, name: l.name, isDefault: l.isDefault, rows: l.rows, cols: l.cols, seats: seatCount(l.cells) }));
}

/** Layout ohne Sichtprüfung – nur intern nach einer Prüfung (Sitzplan-Service). */
export async function layoutById(db: Db, layoutId: string): Promise<RoomLayout | null> {
  const [l] = await db.select().from(roomLayouts).where(eq(roomLayouts.id, layoutId));
  return l ?? null;
}

export interface ExamSeats {
  seats: number;
  layoutName: string;
  /** „pruefung“: Layout der Variante Prüfung, alle Plätze; „jeder-zweite“: aus dem Standard-Layout jeder zweite Platz */
  source: "pruefung" | "jeder-zweite";
}

/**
 * Prüfungsplätze eines Raums (RS-09) für den Klausurplan: ein Layout der Variante „Prüfung“ (Standard bevorzugt, sonst nach
 * Name) zählt mit allen Plätzen; sonst aus dem Standard-Layout jeder zweite Platz. Ohne Layout null (keine Warnung).
 */
export async function examSeatsByRoom(db: Db, roomIds: readonly string[]): Promise<Map<string, ExamSeats>> {
  const out = new Map<string, ExamSeats>();
  if (roomIds.length === 0) return out;
  const all = order(await db.select().from(roomLayouts).where(inArray(roomLayouts.roomId, [...new Set(roomIds)])));
  for (const l of all) {
    const cur = out.get(l.roomId);
    if (l.variant === "pruefung") {
      if (!cur || cur.source !== "pruefung") out.set(l.roomId, { seats: examSeatKeys(l.cells, "pruefung").length, layoutName: l.name, source: "pruefung" });
    } else if (l.isDefault && !cur) out.set(l.roomId, { seats: examSeatKeys(l.cells, l.variant).length, layoutName: l.name, source: "jeder-zweite" });
  }
  return out;
}

/** Rein: Warnung bei Überbelegung – mehr Schüler:innen als Prüfungsplätze. */
export function examSeatWarning(students: number, seats: ExamSeats | undefined, roomId: string): string | null {
  if (!seats || students <= seats.seats) return null;
  const how = seats.source === "pruefung" ? `Layout „${seats.layoutName}“` : `jeder zweite Platz im Layout „${seats.layoutName}“`;
  return `Raum ${roomId}: ${students} Schüler:innen, aber nur ${seats.seats} Prüfungsplätze (${how}).`;
}
