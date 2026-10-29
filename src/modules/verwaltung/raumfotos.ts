// RS-04 (docs/RAUMSTECKBRIEF.md): Fotos je Raum – höchstens 8, auf dem Server auf 1600 px verkleinert, ohne Metadaten
// (EXIF/GPS), mit Vorschaubild, ein Titelbild, Bildunterschrift. Keine Personen auf den Fotos (Hinweis am Upload).
// Sichtbarkeit (Projektleitung 2026-10-28): das Titelbild sehen alle Angemeldeten (auch Schüler:innen/Eltern), die Galerie nur
// Beschäftigte (`roomAudience` = „personal“). Pflegen darf, wer `canEditRoomInfo` erfüllt (RS-06). Dateien liegen im
// Dateispeicher (`storage_key`, `thumb_key` in STORAGE_KEY_COLUMNS) und gehen mit der Dateispeicher-Sicherung ins Backup.
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { roomPhotos, rooms } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { cleanImage, type ImageRules } from "@/core/images";
import { resizeToJpeg } from "@/core/images-resize";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { scanUpload } from "@/modules/upload-scan";
import { ROOM_DATA_PERMISSION, canEditRoomInfo, roomAudience } from "./raum-rechte";
import { ValidationError } from "./users";

export const ROOM_PHOTOS_MAX = 8;
export const ROOM_PHOTO_EDGE = 1600;
export const ROOM_THUMB_EDGE = 480;
export const ROOM_PHOTO_MAX_MB = 20;
export const ROOM_PHOTO_CAPTION_MAX = 120;

const PHOTO_RULES: ImageRules = {
  field: "photo",
  maxBytes: ROOM_PHOTO_MAX_MB * 1024 * 1024,
  types: ["image/jpeg", "image/png", "image/webp"],
  empty: "Bitte ein Foto auswählen",
  tooBig: `Das Foto ist zu groß (höchstens ${ROOM_PHOTO_MAX_MB} MB)`,
  wrongType: "Nur Fotos im Format JPEG, PNG oder WebP",
};

export interface RoomPhoto {
  id: string;
  caption: string | null;
  isCover: boolean;
  width: number;
  height: number;
}

const cols = { id: roomPhotos.id, caption: roomPhotos.caption, isCover: roomPhotos.isCover, width: roomPhotos.width, height: roomPhotos.height };

function normalizeCaption(raw: string | null | undefined): string | null {
  const c = (raw ?? "").trim().replace(/\s+/g, " ");
  if (c.length > ROOM_PHOTO_CAPTION_MAX) throw new ValidationError({ caption: `Bildunterschrift höchstens ${ROOM_PHOTO_CAPTION_MAX} Zeichen` });
  return c || null;
}

/** Fotos eines Raums für die Sicht: Beschäftigte alle (Titelbild zuerst), Schüler:innen/Eltern nur das Titelbild. */
export async function listRoomPhotos(db: Db, viewer: PermissionSet, roomId: string): Promise<RoomPhoto[]> {
  const staff = roomAudience(viewer) === "personal";
  return db
    .select(cols)
    .from(roomPhotos)
    .where(and(eq(roomPhotos.roomId, roomId), staff ? undefined : eq(roomPhotos.isCover, true)))
    .orderBy(desc(roomPhotos.isCover), asc(roomPhotos.createdAt), asc(roomPhotos.id));
}

/** Titelbilder je Raum (Raumliste, Steckbrief-Kopf) – sehen alle Angemeldeten. */
export async function coverPhotos(db: Db, roomIds?: string[]): Promise<Map<string, RoomPhoto>> {
  if (roomIds && roomIds.length === 0) return new Map();
  const rows = await db
    .select({ ...cols, roomId: roomPhotos.roomId })
    .from(roomPhotos)
    .where(and(eq(roomPhotos.isCover, true), roomIds ? inArray(roomPhotos.roomId, roomIds) : undefined));
  return new Map(rows.map(({ roomId, ...p }) => [roomId, p]));
}

/**
 * Lädt ein Foto hoch: Typ an den Bytes, Metadaten weg, verkleinert auf 1600 px (Vorschau 480 px), Virenscan, dann speichern.
 * Das erste Foto eines Raums wird Titelbild. Höchstens acht je Raum – auch bei parallelen Uploads (Sperre je Raum).
 */
export async function addRoomPhoto(
  db: Db,
  storage: FileStorage,
  viewer: PermissionSet,
  roomId: string,
  input: { photo: Uint8Array; caption?: string | null },
): Promise<string> {
  if (!(await canEditRoomInfo(db, viewer, roomId))) throw new ForbiddenError(ROOM_DATA_PERMISSION);
  const [room] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new ValidationError({ photo: `Raum ${roomId} gibt es nicht` });
  const caption = normalizeCaption(input.caption);
  const clean = cleanImage(input.photo, PHOTO_RULES);
  const [full, thumb] = await Promise.all([resizeToJpeg(clean.data, ROOM_PHOTO_EDGE), resizeToJpeg(clean.data, ROOM_THUMB_EDGE, 75)]).catch(() => {
    throw new ValidationError({ photo: "Das Foto lässt sich nicht lesen – bitte als JPEG oder PNG speichern und erneut hochladen" });
  });
  await scanUpload(full.data, "Foto", "photo");

  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`raum:fotos:${roomId}`}))`);
    const existing = await tx.select({ id: roomPhotos.id, isCover: roomPhotos.isCover }).from(roomPhotos).where(eq(roomPhotos.roomId, roomId));
    if (existing.length >= ROOM_PHOTOS_MAX) throw new ValidationError({ photo: `Höchstens ${ROOM_PHOTOS_MAX} Fotos je Raum – erst ein Foto löschen` });
    // Dateien zuerst; bricht danach etwas ab, räumt der Dateispeicher-Lauf sie weg (sweepOrphanFiles)
    const key = newStorageKey();
    const thumbKey = newStorageKey();
    await storage.put(key, full.data);
    await storage.put(thumbKey, thumb.data);
    const [row] = await tx
      .insert(roomPhotos)
      .values({
        roomId,
        storageKey: key,
        thumbKey,
        mime: full.mime,
        size: full.data.length,
        width: full.size.width,
        height: full.size.height,
        caption,
        isCover: !existing.some((p) => p.isCover),
      })
      .returning({ id: roomPhotos.id });
    await audit(tx, viewer.userId, "verwaltung.room.photo.add", roomId, { photo: row!.id });
    return row!.id;
  });
}

async function loadPhoto(db: Db, viewer: PermissionSet, photoId: string) {
  const [p] = await db.select().from(roomPhotos).where(eq(roomPhotos.id, photoId));
  if (!p) throw new ValidationError({ photo: "Foto gibt es nicht" });
  if (!(await canEditRoomInfo(db, viewer, p.roomId))) throw new ForbiddenError(ROOM_DATA_PERMISSION);
  return p;
}

export async function setPhotoCaption(db: Db, viewer: PermissionSet, photoId: string, raw: string): Promise<void> {
  const p = await loadPhoto(db, viewer, photoId);
  const caption = normalizeCaption(raw);
  if (caption === p.caption) return;
  await db.update(roomPhotos).set({ caption }).where(eq(roomPhotos.id, photoId));
  await audit(db, viewer.userId, "verwaltung.room.photo.caption", p.roomId, { photo: photoId });
}

/** Macht ein Foto zum Titelbild des Raums (das bisherige bleibt in der Galerie). */
export async function setCoverPhoto(db: Db, viewer: PermissionSet, photoId: string): Promise<void> {
  const p = await loadPhoto(db, viewer, photoId);
  if (p.isCover) return;
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.update(roomPhotos).set({ isCover: false }).where(and(eq(roomPhotos.roomId, p.roomId), eq(roomPhotos.isCover, true)));
    await tx.update(roomPhotos).set({ isCover: true }).where(eq(roomPhotos.id, photoId));
    await audit(tx, viewer.userId, "verwaltung.room.photo.cover", p.roomId, { photo: photoId });
  });
}

/** Löscht ein Foto samt Dateien; war es das Titelbild, wird das älteste übrige Foto Titelbild. */
export async function deleteRoomPhoto(db: Db, storage: FileStorage, viewer: PermissionSet, photoId: string): Promise<void> {
  const p = await loadPhoto(db, viewer, photoId);
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.delete(roomPhotos).where(eq(roomPhotos.id, photoId));
    if (p.isCover) {
      const [next] = await tx
        .select({ id: roomPhotos.id })
        .from(roomPhotos)
        .where(and(eq(roomPhotos.roomId, p.roomId), ne(roomPhotos.id, photoId)))
        .orderBy(asc(roomPhotos.createdAt), asc(roomPhotos.id))
        .limit(1);
      if (next) await tx.update(roomPhotos).set({ isCover: true }).where(eq(roomPhotos.id, next.id));
    }
    await audit(tx, viewer.userId, "verwaltung.room.photo.delete", p.roomId, { photo: photoId });
  });
  // Dateien nach dem Löschen des Datensatzes; schlägt das fehl, räumt der Dateispeicher-Lauf auf
  await storage.delete(p.storageKey).catch(() => {});
  await storage.delete(p.thumbKey).catch(() => {});
}

/**
 * Foto für die Auslieferung (Route /api/raeume/foto/[id]): das Titelbild für alle Angemeldeten, andere Fotos nur für
 * Beschäftigte. null = nicht vorhanden oder nicht sichtbar (die Route antwortet dann einheitlich 404).
 */
export async function photoFile(db: Db, viewer: PermissionSet, photoId: string, small: boolean): Promise<{ key: string; mime: string } | null> {
  const [p] = await db
    .select({ storageKey: roomPhotos.storageKey, thumbKey: roomPhotos.thumbKey, mime: roomPhotos.mime, isCover: roomPhotos.isCover })
    .from(roomPhotos)
    .where(eq(roomPhotos.id, photoId));
  if (!p) return null;
  if (!p.isCover && roomAudience(viewer) !== "personal") return null;
  return { key: small ? p.thumbKey : p.storageKey, mime: p.mime };
}
