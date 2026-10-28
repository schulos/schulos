// RS-05 (docs/RAUMSTECKBRIEF.md): Ausstattung als selbstwachsender, schulweiter Katalog mit Menge je Raum. Wer am Raum eine
// Ausstattung einträgt, wählt per Typeahead aus dem Katalog; ein unbekannter Name wird beim ersten Eintrag automatisch
// aufgenommen und ist danach für alle Räume wählbar. Keine getrennte Katalogpflege – die Verwaltung (`verwaltung.school`)
// benennt um und führt Dubletten zusammen. Ersetzt die feste Liste `rooms.equipment` (Migration 0117 übernimmt den Bestand).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { roomEquipmentItems, roomEquipmentTypes, rooms } from "@/core/db/schema";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { canEditRoomInfo, canManageInfoFields } from "./raum-rechte";
import { ValidationError } from "./users";

export const EQUIPMENT_NAME_MAX = 60;
export const EQUIPMENT_QUANTITY_MAX = 9999;
/** Grenze gegen Wildwuchs: so viele Katalogeinträge bzw. Einträge je Raum. */
export const EQUIPMENT_TYPES_MAX = 500;
export const EQUIPMENT_PER_ROOM_MAX = 100;

/** Die acht früheren festen Einträge (Schlüssel = ID) – dieselben legt Migration 0117 an. */
export const DEFAULT_EQUIPMENT_TYPES = [
  { id: "beamer", name: "Beamer" },
  { id: "tafel_digital", name: "Digitale Tafel" },
  { id: "dokukamera", name: "Dokumentenkamera" },
  { id: "lehrer_pc", name: "Lehrer-PC" },
  { id: "schueler_pcs", name: "Schüler-PCs" },
  { id: "audio", name: "Audioanlage" },
  { id: "waschbecken", name: "Waschbecken" },
  { id: "abzug", name: "Abzug" },
] as const;
export type DefaultEquipmentId = (typeof DEFAULT_EQUIPMENT_TYPES)[number]["id"];

/** Legt fehlende Vorgabe-Einträge an (Demo-Seed nach dem Leeren aller Tabellen); vorhandene bleiben unverändert. */
export async function ensureDefaultEquipmentTypes(db: Db): Promise<void> {
  await db
    .insert(roomEquipmentTypes)
    .values(DEFAULT_EQUIPMENT_TYPES.map((t) => ({ ...t })))
    .onConflictDoNothing();
}

/** Rein: Name wie gespeichert – Leerraum zusammengefasst und an den Rändern entfernt. */
export function normalizeEquipmentName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Rein: Menge aus einem Formularwert; leer = 1. */
export function parseQuantity(raw: string | number | null | undefined, field = "quantity"): number {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  const n = s === "" ? 1 : Number(s);
  if (!Number.isInteger(n) || n < 1 || n > EQUIPMENT_QUANTITY_MAX) throw new ValidationError({ [field]: `Menge 1–${EQUIPMENT_QUANTITY_MAX}` });
  return n;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "de", { sensitivity: "base" });

export interface EquipmentType {
  id: string;
  name: string;
  /** Räume, in denen der Eintrag vorkommt (auch stillgelegte) */
  rooms: number;
}

/** Katalog mit Verwendung, nach Name sortiert (in JS, nicht per Collation). */
export async function listEquipmentTypes(db: Db): Promise<EquipmentType[]> {
  const rows = await db
    .select({ id: roomEquipmentTypes.id, name: roomEquipmentTypes.name, rooms: sql<number>`count(${roomEquipmentItems.roomId})::int` })
    .from(roomEquipmentTypes)
    .leftJoin(roomEquipmentItems, eq(roomEquipmentItems.typeId, roomEquipmentTypes.id))
    .groupBy(roomEquipmentTypes.id, roomEquipmentTypes.name);
  return rows.sort(byName);
}

export interface RoomEquipmentEntry {
  typeId: string;
  name: string;
  quantity: number;
}

/** Ausstattung je Raum (alle Räume oder die genannten), Einträge nach Name sortiert. Grobe Ausstattung sehen alle. */
export async function equipmentByRoom(db: Db, roomIds?: string[]): Promise<Map<string, RoomEquipmentEntry[]>> {
  if (roomIds && roomIds.length === 0) return new Map();
  const rows = await db
    .select({ roomId: roomEquipmentItems.roomId, typeId: roomEquipmentItems.typeId, name: roomEquipmentTypes.name, quantity: roomEquipmentItems.quantity })
    .from(roomEquipmentItems)
    .innerJoin(roomEquipmentTypes, eq(roomEquipmentTypes.id, roomEquipmentItems.typeId))
    .where(roomIds ? inArray(roomEquipmentItems.roomId, roomIds) : undefined);
  const out = new Map<string, RoomEquipmentEntry[]>();
  for (const r of rows.sort(byName)) {
    const list = out.get(r.roomId) ?? [];
    list.push({ typeId: r.typeId, name: r.name, quantity: r.quantity });
    out.set(r.roomId, list);
  }
  return out;
}

export async function roomEquipment(db: Db, roomId: string): Promise<RoomEquipmentEntry[]> {
  return (await equipmentByRoom(db, [roomId])).get(roomId) ?? [];
}

/** Rein: „Beamer“, „2 × Lehrer-PC“. */
export function equipmentLabel(e: Pick<RoomEquipmentEntry, "name" | "quantity">): string {
  return e.quantity > 1 ? `${e.quantity} × ${e.name}` : e.name;
}

async function requireRoom(db: Db, roomId: string) {
  const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new ValidationError({ room: `Raum ${roomId} gibt es nicht` });
}

/** Katalogeintrag zum Namen (Groß-/Kleinschreibung egal) – null, wenn es ihn noch nicht gibt. */
export async function findEquipmentType(db: Db, name: string): Promise<{ id: string; name: string } | null> {
  const n = normalizeEquipmentName(name);
  const [row] = await db
    .select({ id: roomEquipmentTypes.id, name: roomEquipmentTypes.name })
    .from(roomEquipmentTypes)
    .where(sql`lower(${roomEquipmentTypes.name}) = lower(${n})`);
  return row ?? null;
}

/**
 * Trägt eine Ausstattung am Raum ein (Typeahead: Name aus dem Katalog oder neu). Ein unbekannter Name wird dabei in den
 * Katalog aufgenommen; Groß-/Kleinschreibung und Leerraum zählen nicht („beamer“ = „Beamer“). Steht die Ausstattung schon
 * am Raum, gilt die neue Menge. Gibt den Katalogeintrag zurück und ob er neu ist.
 */
export async function addRoomEquipment(
  db: Db,
  viewer: PermissionSet,
  roomId: string,
  input: { name: string; quantity?: string | number | null },
): Promise<{ typeId: string; name: string; created: boolean }> {
  if (!canEditRoomInfo(viewer, roomId)) throw new ForbiddenError("verwaltung.school");
  await requireRoom(db, roomId);
  const name = normalizeEquipmentName(input.name);
  const fe: Record<string, string> = {};
  if (!name) fe.name = "Ausstattung angeben";
  else if (name.length > EQUIPMENT_NAME_MAX) fe.name = `Höchstens ${EQUIPMENT_NAME_MAX} Zeichen`;
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const quantity = parseQuantity(input.quantity);

  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    // gleichzeitiges Anlegen desselben Namens: der eindeutige Index auf lower(name) entscheidet, danach gilt der vorhandene Eintrag
    let type = await findEquipmentType(tx, name);
    let created = false;
    if (!type) {
      const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(roomEquipmentTypes)) as [{ n: number }];
      if (n >= EQUIPMENT_TYPES_MAX) throw new ValidationError({ name: `Der Katalog ist voll (höchstens ${EQUIPMENT_TYPES_MAX} Einträge) – bitte vorhandene wählen` });
      const [row] = await tx.insert(roomEquipmentTypes).values({ name }).onConflictDoNothing().returning({ id: roomEquipmentTypes.id, name: roomEquipmentTypes.name });
      type = row ?? (await findEquipmentType(tx, name));
      if (!type) throw new ValidationError({ name: "Ausstattung konnte nicht angelegt werden" });
      created = !!row;
      if (created) await audit(tx, viewer.userId, "verwaltung.room.equipment_type.create", type.id, { name: type.name, roomId });
    }
    const [{ n: inRoom }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(roomEquipmentItems).where(eq(roomEquipmentItems.roomId, roomId))) as [{ n: number }];
    const [existing] = await tx
      .select({ quantity: roomEquipmentItems.quantity })
      .from(roomEquipmentItems)
      .where(and(eq(roomEquipmentItems.roomId, roomId), eq(roomEquipmentItems.typeId, type.id)));
    if (!existing && inRoom >= EQUIPMENT_PER_ROOM_MAX) throw new ValidationError({ name: `Höchstens ${EQUIPMENT_PER_ROOM_MAX} Einträge je Raum` });
    const now = new Date();
    await tx
      .insert(roomEquipmentItems)
      .values({ roomId, typeId: type.id, quantity, updatedAt: now })
      .onConflictDoUpdate({ target: [roomEquipmentItems.roomId, roomEquipmentItems.typeId], set: { quantity, updatedAt: now } });
    await audit(tx, viewer.userId, "verwaltung.room.equipment", roomId, { set: type.name, quantity, ...(existing ? { quantityFrom: existing.quantity } : {}) });
    return { typeId: type.id, name: type.name, created };
  });
}

/**
 * Mengen der vorhandenen Ausstattung eines Raums ändern (`quantities`: Katalog-ID → Menge; 0 entfernt). Nur Änderungen werden
 * geschrieben; gibt deren Zahl zurück.
 */
export async function setRoomEquipmentQuantities(db: Db, viewer: PermissionSet, roomId: string, quantities: Record<string, string | number>): Promise<number> {
  if (!canEditRoomInfo(viewer, roomId)) throw new ForbiddenError("verwaltung.school");
  await requireRoom(db, roomId);
  const current = await roomEquipment(db, roomId);
  const byId = new Map(current.map((e) => [e.typeId, e]));
  const fe: Record<string, string> = {};
  const next = new Map<string, number>();
  for (const [typeId, raw] of Object.entries(quantities)) {
    if (!byId.has(typeId)) {
      fe[typeId] = "Diese Ausstattung steht nicht am Raum";
      continue;
    }
    if (String(raw).trim() === "0") {
      next.set(typeId, 0);
      continue;
    }
    try {
      next.set(typeId, parseQuantity(raw, typeId));
    } catch (err) {
      if (err instanceof ValidationError) Object.assign(fe, err.fieldErrors);
      else throw err;
    }
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const changed = [...next].filter(([id, q]) => byId.get(id)!.quantity !== q);
  if (!changed.length) return 0;
  const now = new Date();
  for (const [typeId, q] of changed) {
    const where = and(eq(roomEquipmentItems.roomId, roomId), eq(roomEquipmentItems.typeId, typeId));
    if (q === 0) await db.delete(roomEquipmentItems).where(where);
    else await db.update(roomEquipmentItems).set({ quantity: q, updatedAt: now }).where(where);
  }
  await audit(db, viewer.userId, "verwaltung.room.equipment", roomId, {
    changed: changed.map(([id, q]) => `${byId.get(id)!.name}: ${byId.get(id)!.quantity} → ${q}`),
  });
  return changed.length;
}

// ---------------------------------------------------------------- Katalog aufräumen (Verwaltung)

async function loadType(db: Db, id: string) {
  const [t] = await db.select().from(roomEquipmentTypes).where(eq(roomEquipmentTypes.id, id));
  if (!t) throw new ValidationError({ name: "Diesen Katalogeintrag gibt es nicht" });
  return t;
}

/** Benennt einen Katalogeintrag um – gilt in allen Räumen. Gibt es den Namen schon, ist Zusammenführen der Weg. */
export async function renameEquipmentType(db: Db, viewer: PermissionSet, id: string, rawName: string): Promise<void> {
  if (!canManageInfoFields(viewer)) throw new ForbiddenError("verwaltung.school");
  const old = await loadType(db, id);
  const name = normalizeEquipmentName(rawName);
  if (!name) throw new ValidationError({ name: "Name angeben" });
  if (name.length > EQUIPMENT_NAME_MAX) throw new ValidationError({ name: `Höchstens ${EQUIPMENT_NAME_MAX} Zeichen` });
  if (name === old.name) return;
  const dup = await findEquipmentType(db, name);
  if (dup && dup.id !== id) throw new ValidationError({ name: `„${dup.name}“ gibt es schon – stattdessen zusammenführen` });
  await db.update(roomEquipmentTypes).set({ name }).where(eq(roomEquipmentTypes.id, id));
  await audit(db, viewer.userId, "verwaltung.room.equipment_type.rename", id, { name, nameFrom: old.name });
}

/**
 * Führt eine Dublette mit einem anderen Eintrag zusammen: Räume mit `fromId` bekommen `intoId`, `fromId` verschwindet aus dem
 * Katalog. Hat ein Raum beide, gilt die größere Menge (Dubletten meinen dieselbe Sache, doppelt eingetragen).
 * Gibt die Zahl der umgehängten Räume zurück.
 */
export async function mergeEquipmentTypes(db: Db, viewer: PermissionSet, fromId: string, intoId: string): Promise<number> {
  if (!canManageInfoFields(viewer)) throw new ForbiddenError("verwaltung.school");
  if (fromId === intoId) throw new ValidationError({ into: "Bitte einen anderen Eintrag wählen" });
  const [from, into] = [await loadType(db, fromId), await loadType(db, intoId)];
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const items = await tx.select().from(roomEquipmentItems).where(eq(roomEquipmentItems.typeId, fromId)).orderBy(asc(roomEquipmentItems.roomId));
    const now = new Date();
    for (const it of items) {
      await tx
        .insert(roomEquipmentItems)
        .values({ roomId: it.roomId, typeId: intoId, quantity: it.quantity, updatedAt: now })
        .onConflictDoUpdate({
          target: [roomEquipmentItems.roomId, roomEquipmentItems.typeId],
          set: { quantity: sql`greatest(${roomEquipmentItems.quantity}, excluded.quantity)`, updatedAt: now },
        });
    }
    await tx.delete(roomEquipmentTypes).where(eq(roomEquipmentTypes.id, fromId)); // Zeilen von `from` gehen per Kaskade
    await audit(tx, viewer.userId, "verwaltung.room.equipment_type.merge", intoId, { name: into.name, merged: from.name, rooms: items.length });
    return items.length;
  });
}

/** Löscht einen Katalogeintrag, der in keinem Raum mehr vorkommt (sonst zusammenführen oder erst am Raum entfernen). */
export async function deleteEquipmentType(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  if (!canManageInfoFields(viewer)) throw new ForbiddenError("verwaltung.school");
  const old = await loadType(db, id);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(roomEquipmentItems).where(eq(roomEquipmentItems.typeId, id))) as [{ n: number }];
  if (n > 0) throw new ValidationError({ name: `„${old.name}“ steht noch in ${n} ${n === 1 ? "Raum" : "Räumen"} – zusammenführen oder dort entfernen` });
  await db.delete(roomEquipmentTypes).where(eq(roomEquipmentTypes.id, id));
  await audit(db, viewer.userId, "verwaltung.room.equipment_type.delete", id, { name: old.name });
}
