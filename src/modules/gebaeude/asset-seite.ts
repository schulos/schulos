// INV-03 (docs/INVENTAR.md, Stufe 2): Aktionen der mobilen Asset-Seite – Zustand und Standort per Knopf, Fotos je Inventargut
// (wie Raumfotos: 1600 px, Vorschau 480 px, ohne Metadaten, Virenscan), Historie aus dem Audit-Log (`gebaeude.asset.*` mit Ziel =
// Inventar-ID, wie die Raumhistorie). Schreiben darf, wer die Kategorie pflegt (`requireMaintain`); Fotos und Historie sieht nur, wer
// die volle Sicht hat (`view_all` oder Pflegende der Kategorie) – die eingeschränkte Sicht (inv-5) bleibt bei Bezeichnung, Kategorie,
// Standort und „Mangel melden“. Kein Personenbezug in den Daten: wer etwas getan hat, steht nur im Audit-Log.
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { auditLog, gebaeudeAssetPhotos, gebaeudeAssets, rooms, users } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { cleanImage, type ImageRules } from "@/core/images";
import { resizeToJpeg } from "@/core/images-resize";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { scanUpload } from "@/modules/upload-scan";
import { ACTION_LABELS } from "@/modules/verwaltung/audit-view";
import { ValidationError } from "@/modules/verwaltung/users";
import { INVENTORY_PERMISSION, maintainableCategories, requireMaintain } from "./inventar";
import { ASSET_CONDITIONS, ASSET_PHOTOS_MAX, ASSET_PHOTO_MAX_MB, CONDITION_LABELS, INVENTORY_ITEM_STATE_LABELS, type AssetCondition, type InventoryItemState } from "./labels";
import { canViewAll } from "./service";

export const ASSET_PHOTO_EDGE = 1600;
export const ASSET_THUMB_EDGE = 480;
export const ASSET_HISTORY_LIMIT = 50;

const PHOTO_RULES: ImageRules = {
  field: "photo",
  maxBytes: ASSET_PHOTO_MAX_MB * 1024 * 1024,
  types: ["image/jpeg", "image/png", "image/webp"],
  empty: "Bitte ein Foto auswählen",
  tooBig: `Das Foto ist zu groß (höchstens ${ASSET_PHOTO_MAX_MB} MB)`,
  wrongType: "Nur Fotos im Format JPEG, PNG oder WebP",
};

async function loadAsset(db: Db, id: string) {
  const [a] = await db
    .select({ id: gebaeudeAssets.id, categoryId: gebaeudeAssets.categoryId, active: gebaeudeAssets.active, condition: gebaeudeAssets.condition, roomId: gebaeudeAssets.roomId })
    .from(gebaeudeAssets)
    .where(eq(gebaeudeAssets.id, id));
  if (!a) throw new ValidationError({ asset: "Inventar gibt es nicht" });
  return a;
}

/** Volle Sicht auf ein Inventargut (Fotos, Historie): `view_all` oder Pflegende der Kategorie – wie `getAsset().full`. */
async function hasFullView(db: Db, viewer: PermissionSet, categoryId: string): Promise<boolean> {
  if (canViewAll(viewer)) return true;
  const own = await maintainableCategories(db, viewer);
  return own === null || own.has(categoryId);
}

// ---------------------------------------------------------------- Zustand und Standort per Knopf

/** Zustand setzen (neu/gut/gebraucht/defekt, `null` = offen). Nur in Betrieb befindliches Inventar; Audit mit vorher/nachher. */
export async function setAssetCondition(db: Db, viewer: PermissionSet, id: string, raw: string | null): Promise<void> {
  const a = await loadAsset(db, id);
  await requireMaintain(db, viewer, a.categoryId);
  const condition = raw?.trim() || null;
  if (condition && !(ASSET_CONDITIONS as readonly string[]).includes(condition)) throw new ValidationError({ condition: "Zustand wählen" });
  if (!a.active) throw new ValidationError({ condition: "Das Gerät ist ausgemustert" });
  if (condition === a.condition) return;
  await db.update(gebaeudeAssets).set({ condition: condition as AssetCondition | null }).where(eq(gebaeudeAssets.id, id));
  await audit(db, viewer.userId, "gebaeude.asset.condition", id, { from: a.condition, to: condition });
}

/**
 * Standort ändern (Umzug in einen anderen Raum). Gebäude/Etage ergeben sich danach aus dem Raum; abweichende Angaben ohne Raum
 * (z. B. „Pausenhof“) bleiben dem Formular „Angaben ändern“ vorbehalten.
 */
export async function moveAsset(db: Db, viewer: PermissionSet, id: string, rawRoomId: string): Promise<void> {
  const a = await loadAsset(db, id);
  await requireMaintain(db, viewer, a.categoryId);
  const roomId = rawRoomId.trim();
  if (!roomId) throw new ValidationError({ roomId: "Raum wählen" });
  if (!a.active) throw new ValidationError({ roomId: "Das Gerät ist ausgemustert" });
  const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
  if (!r) throw new ValidationError({ roomId: "Raum gibt es nicht" });
  if (r.id === a.roomId) return;
  await db.update(gebaeudeAssets).set({ roomId: r.id, buildingId: null, floorId: null }).where(eq(gebaeudeAssets.id, id));
  await audit(db, viewer.userId, "gebaeude.asset.move", id, { from: a.roomId, to: r.id });
}

// ---------------------------------------------------------------- Fotos

export interface AssetPhoto {
  id: string;
  width: number;
  height: number;
}

/** Fotos eines Inventarguts (älteste zuerst) – nur mit voller Sicht, sonst leer. */
export async function listAssetPhotos(db: Db, viewer: PermissionSet, assetId: string): Promise<AssetPhoto[]> {
  const [a] = await db.select({ categoryId: gebaeudeAssets.categoryId }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, assetId));
  if (!a || !(await hasFullView(db, viewer, a.categoryId))) return [];
  return db
    .select({ id: gebaeudeAssetPhotos.id, width: gebaeudeAssetPhotos.width, height: gebaeudeAssetPhotos.height })
    .from(gebaeudeAssetPhotos)
    .where(eq(gebaeudeAssetPhotos.assetId, assetId))
    .orderBy(asc(gebaeudeAssetPhotos.createdAt), asc(gebaeudeAssetPhotos.id));
}

/**
 * Foto hochladen (Pflegende der Kategorie): Typ an den Bytes, Metadaten weg, verkleinert, Virenscan, dann speichern. Höchstens
 * ASSET_PHOTOS_MAX je Inventargut – auch bei parallelen Uploads (Sperre je Inventargut).
 */
export async function addAssetPhoto(db: Db, storage: FileStorage, viewer: PermissionSet, assetId: string, photo: Uint8Array): Promise<string> {
  const a = await loadAsset(db, assetId);
  await requireMaintain(db, viewer, a.categoryId);
  const clean = cleanImage(photo, PHOTO_RULES);
  const [full, thumb] = await Promise.all([resizeToJpeg(clean.data, ASSET_PHOTO_EDGE), resizeToJpeg(clean.data, ASSET_THUMB_EDGE, 75)]).catch(() => {
    throw new ValidationError({ photo: "Das Foto lässt sich nicht lesen – bitte als JPEG oder PNG speichern und erneut hochladen" });
  });
  await scanUpload(full.data, "Foto", "photo");
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gebaeude:asset-fotos:${assetId}`}))`);
    const [n] = await tx.select({ n: count() }).from(gebaeudeAssetPhotos).where(eq(gebaeudeAssetPhotos.assetId, assetId));
    if ((n?.n ?? 0) >= ASSET_PHOTOS_MAX) throw new ValidationError({ photo: `Höchstens ${ASSET_PHOTOS_MAX} Fotos je Gerät – erst ein Foto löschen` });
    // Dateien zuerst; bricht danach etwas ab, räumt der Dateispeicher-Lauf sie weg (sweepOrphanFiles)
    const key = newStorageKey();
    const thumbKey = newStorageKey();
    await storage.put(key, full.data);
    await storage.put(thumbKey, thumb.data);
    const [row] = await tx
      .insert(gebaeudeAssetPhotos)
      .values({ assetId, storageKey: key, thumbKey, mime: full.mime, size: full.data.length, width: full.size.width, height: full.size.height })
      .returning({ id: gebaeudeAssetPhotos.id });
    await audit(tx, viewer.userId, "gebaeude.asset.photo.add", assetId, { photo: row!.id });
    return row!.id;
  });
}

/** Foto löschen (Pflegende der Kategorie) samt Dateien. */
export async function deleteAssetPhoto(db: Db, storage: FileStorage, viewer: PermissionSet, photoId: string): Promise<string> {
  const [p] = await db
    .select({ assetId: gebaeudeAssetPhotos.assetId, storageKey: gebaeudeAssetPhotos.storageKey, thumbKey: gebaeudeAssetPhotos.thumbKey, categoryId: gebaeudeAssets.categoryId })
    .from(gebaeudeAssetPhotos)
    .innerJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeAssetPhotos.assetId))
    .where(eq(gebaeudeAssetPhotos.id, photoId));
  if (!p) throw new ValidationError({ photo: "Foto gibt es nicht" });
  await requireMaintain(db, viewer, p.categoryId);
  await db.delete(gebaeudeAssetPhotos).where(eq(gebaeudeAssetPhotos.id, photoId));
  await audit(db, viewer.userId, "gebaeude.asset.photo.delete", p.assetId, { photo: photoId });
  // Dateien nach dem Datensatz; schlägt das fehl, räumt der Dateispeicher-Lauf auf
  await storage.delete(p.storageKey).catch(() => {});
  await storage.delete(p.thumbKey).catch(() => {});
  return p.assetId;
}

/** Foto für die Auslieferung (Route `/api/gebaeude/inventar-foto/<id>`): nur mit voller Sicht; `null` = nicht vorhanden oder nicht sichtbar. */
export async function assetPhotoFile(db: Db, viewer: PermissionSet, photoId: string, small: boolean): Promise<{ key: string; mime: string } | null> {
  const [p] = await db
    .select({ storageKey: gebaeudeAssetPhotos.storageKey, thumbKey: gebaeudeAssetPhotos.thumbKey, mime: gebaeudeAssetPhotos.mime, categoryId: gebaeudeAssets.categoryId })
    .from(gebaeudeAssetPhotos)
    .innerJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeAssetPhotos.assetId))
    .where(eq(gebaeudeAssetPhotos.id, photoId));
  if (!p || !(await hasFullView(db, viewer, p.categoryId))) return null;
  return { key: small ? p.thumbKey : p.storageKey, mime: p.mime };
}

// ---------------------------------------------------------------- Historie

/** Vorgänge, die zur Historie eines Inventarguts gehören (Ziel = Inventar-ID). Prüfungen und Meldungen zeigt die Seite getrennt. */
export const ASSET_HISTORY_ACTIONS = [
  "gebaeude.asset.create",
  "gebaeude.asset.update",
  "gebaeude.asset.condition",
  "gebaeude.asset.move",
  "gebaeude.asset.activate",
  "gebaeude.asset.deactivate",
  "gebaeude.asset.photo.add",
  "gebaeude.asset.photo.delete",
  "gebaeude.asset.qr.create",
  "gebaeude.asset.qr.renew",
  "gebaeude.asset.inventur",
  "gebaeude.asset.loan",
  "gebaeude.asset.loan.extend",
  "gebaeude.asset.loan.cancel",
  "gebaeude.asset.return",
] as const;

export interface AssetHistoryEntry {
  id: number;
  at: Date;
  label: string;
  detail: string | null;
  actor: string;
}

const conditionText = (v: unknown) => (typeof v === "string" && v in CONDITION_LABELS ? CONDITION_LABELS[v as AssetCondition] : "offen");
const inventoryStateText = (v: unknown) => (typeof v === "string" && v in INVENTORY_ITEM_STATE_LABELS ? INVENTORY_ITEM_STATE_LABELS[v as InventoryItemState] : "erfasst");
const dayText = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : ymd);
const roomText = (v: unknown) => (typeof v === "string" && v ? `Raum ${v}` : "ohne Raum");

/**
 * Änderungen eines Inventarguts aus dem Audit-Log, neueste zuerst – nur mit voller Sicht (`view_all` oder Pflegende). Handelnde
 * werden wie in der Raumhistorie genannt (Berechtigte, DATENSCHUTZ §3.4); pseudonymisierte Einträge bleiben pseudonym.
 */
export async function assetHistory(db: Db, viewer: PermissionSet, assetId: string, limit = ASSET_HISTORY_LIMIT): Promise<AssetHistoryEntry[]> {
  const [a] = await db.select({ categoryId: gebaeudeAssets.categoryId }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, assetId));
  if (!a) throw new ValidationError({ asset: "Inventar gibt es nicht" });
  if (!(await hasFullView(db, viewer, a.categoryId))) throw new ForbiddenError(INVENTORY_PERMISSION);
  const actor = alias(users, "actor");
  const rows = await db
    .select({ id: auditLog.id, at: auditLog.createdAt, action: auditLog.action, meta: auditLog.meta, actorName: actor.name, actorPseudonym: auditLog.actorPseudonym, actorId: auditLog.actorId })
    .from(auditLog)
    .leftJoin(actor, eq(actor.id, auditLog.actorId))
    .where(and(eq(auditLog.target, assetId), inArray(auditLog.action, [...ASSET_HISTORY_ACTIONS])))
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return rows.map((r) => {
    const m = (r.meta ?? {}) as Record<string, unknown>;
    let detail: string | null = null;
    if (r.action === "gebaeude.asset.condition") detail = `${conditionText(m.from)} → ${conditionText(m.to)}`;
    else if (r.action === "gebaeude.asset.move") detail = `${roomText(m.from)} → ${roomText(m.to)}`;
    else if (r.action === "gebaeude.asset.inventur") detail = `${inventoryStateText(m.state)} · Inventur ${roomText(m.room)}`;
    // INV-05: ohne Namen der entleihenden Person – die steht nur an der Ausleihe (Löschfrist), nicht im Audit
    else if (r.action === "gebaeude.asset.loan") detail = typeof m.due === "string" ? `bis ${dayText(m.due)}` : null;
    else if (r.action === "gebaeude.asset.loan.extend") detail = typeof m.from === "string" && typeof m.to === "string" ? `${dayText(m.from)} → ${dayText(m.to)}` : null;
    else if (r.action === "gebaeude.asset.return") detail = [m.late === true ? "nach Fristende" : null, m.finding === true ? "mit Befund" : null].filter(Boolean).join(" · ") || null;
    return {
      id: r.id,
      at: r.at,
      label: ACTION_LABELS[r.action] ?? r.action,
      detail,
      actor: r.actorName ?? (r.actorPseudonym ? `Pseudonym ${r.actorPseudonym}` : r.actorId ? "gelöschtes Konto" : "System"),
    };
  });
}
