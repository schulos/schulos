// RS-11 Tür-QR: je Raum ein nicht erratbarer, stabiler Code für die Kurz-URL `/r/<code>` (Unterbau `src/core/etiketten/`).
// Drucken und Neuerzeugen darf, wer die Raumdaten des Raums pflegt (`canEditRoomInfo`: Recht „Raumdaten pflegen“,
// `verwaltung.school`, Raumverantwortliche für den eigenen Raum). Ohne Anmeldung verrät `/r/…` nichts (Seite `src/app/r`).
import { eq, inArray, or } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { roomResponsibles, rooms } from "@/core/db/schema";
import { ensureLabelCodes, labelCodesFor, renewLabelCode } from "@/core/etiketten/service";
import { ForbiddenError, accessBlocked, type PermissionSet } from "@/core/permissions";
import { isStaffRole } from "@/core/roles";
import { ROOM_DATA_PERMISSION, canEditRoomInfo, canMaintainAllRooms } from "./raum-rechte";
import { roomDirectory } from "./raumsteckbrief";
import { ValidationError } from "./users";

/** Räume (IDs), deren Raumdaten die Person pflegt – Grundlage für Tür-QR drucken und neu erzeugen. `null` = alle. */
async function editableRooms(db: Db, viewer: PermissionSet): Promise<Set<string> | null> {
  if (canMaintainAllRooms(viewer)) return null;
  if (accessBlocked(viewer) || !isStaffRole(viewer.role)) return new Set();
  const groups = [...viewer.memberOf];
  const rows = await db
    .select({ roomId: roomResponsibles.roomId })
    .from(roomResponsibles)
    .where(groups.length ? or(eq(roomResponsibles.userId, viewer.userId), inArray(roomResponsibles.groupId, groups)) : eq(roomResponsibles.userId, viewer.userId));
  return new Set(rows.map((r) => r.roomId));
}

/** Darf die Person überhaupt Türschilder drucken (mindestens einen Raum pflegen)? */
export async function canPrintDoorSigns(db: Db, viewer: PermissionSet): Promise<boolean> {
  const editable = await editableRooms(db, viewer);
  return editable === null || editable.size > 0;
}

/** Aktive Räume, für die die Person Türschilder drucken darf (Reihenfolge wie im Raumfinder). */
export async function printableRooms(db: Db, viewer: PermissionSet, place: { buildingId?: string } = {}) {
  const editable = await editableRooms(db, viewer);
  if (editable && editable.size === 0) return [];
  const list = await roomDirectory(db, undefined, 2000, place);
  return editable ? list.filter((r) => editable.has(r.id)) : list;
}

export interface DoorSign {
  roomId: string;
  name: string;
  building: string | null;
  floor: string | null;
  code: string;
}

/**
 * Türschilder für die gewählten Räume (nur aktive, nur pflegbare – andere fallen still weg). Fehlende Codes werden angelegt
 * (Audit `verwaltung.room.qr.create`), vorhandene bleiben – ein Nachdruck passt zum Schild an der Tür.
 */
export async function doorSigns(db: Db, viewer: PermissionSet, roomIds: readonly string[] | "alle", place: { buildingId?: string } = {}): Promise<DoorSign[]> {
  const allowed = await printableRooms(db, viewer, place);
  const wanted = roomIds === "alle" ? null : new Set(roomIds);
  const list = wanted ? allowed.filter((r) => wanted.has(r.id)) : allowed;
  if (!list.length) return [];
  const { codes, created } = await ensureLabelCodes(
    db,
    "raum",
    list.map((r) => r.id),
  );
  for (const id of created) await audit(db, viewer.userId, "verwaltung.room.qr.create", id, {});
  return list.map((r) => ({ roomId: r.id, name: r.name, building: r.building, floor: r.floor, code: codes.get(r.id)! }));
}

/** Code des Raums für die Anzeige im Steckbrief – nur für Pflegende, sonst `null`; legt nichts an. */
export async function roomCode(db: Db, viewer: PermissionSet, roomId: string): Promise<string | null> {
  if (!(await canEditRoomInfo(db, viewer, roomId))) return null;
  return (await labelCodesFor(db, "raum", [roomId])).get(roomId) ?? null;
}

/** Neuen Code erzeugen (Schild verloren, Code abfotografiert …): der alte Code führt danach nirgends mehr hin. */
export async function renewRoomCode(db: Db, viewer: PermissionSet, roomId: string): Promise<string> {
  if (!(await canEditRoomInfo(db, viewer, roomId))) throw new ForbiddenError(ROOM_DATA_PERMISSION);
  const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new ValidationError({ room: `Raum ${roomId} gibt es nicht` });
  const code = await renewLabelCode(db, "raum", room.id);
  // der Code selbst steht nicht im Protokoll
  await audit(db, viewer.userId, "verwaltung.room.qr.renew", room.id, {});
  return code;
}
