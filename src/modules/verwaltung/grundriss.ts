// RS-13 (docs/RAUMSTECKBRIEF.md „Grundriss je Etage“): ein Plan-Bild je Etage, Räume als Punkt darauf. Entscheidungen der
// Projektleitung 2026-11-03: Punkt statt Fläche; sichtbar für alle Angemeldeten, per Moduleinstellung nur für Personal;
// Plan und Punkte pflegt nur `verwaltung.school`; JPEG/PNG/WebP (kein PDF, kein SVG); ein Plan je Etage; feste Zeile
// „Nicht als Flucht- und Rettungsplan verwenden“. Upload nach dem Muster der Raumfotos (RS-04): Typ an den Bytes, verkleinert,
// ohne Metadaten, Virenscan; Dateien im Dateispeicher (`plan_key`, `plan_thumb_key` in STORAGE_KEY_COLUMNS) und damit im Backup.
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { buildingFloors, buildings, rooms } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { cleanImage, type ImageRules } from "@/core/images";
import { resizeToJpeg } from "@/core/images-resize";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { scanUpload } from "@/modules/upload-scan";
import { roomAudience } from "./raum-rechte";
import { FLOOR_PLAN_VISIBILITY } from "./settings";
import { ValidationError } from "./users";

/** Längste Kante des gespeicherten Plans – größer als bei Raumfotos, damit Raumnummern lesbar bleiben. */
export const FLOOR_PLAN_EDGE = 2400;
export const FLOOR_PLAN_THUMB_EDGE = 800;
export const FLOOR_PLAN_MAX_MB = 20;
export const FLOOR_PLAN_ALT_MIN = 10;
export const FLOOR_PLAN_ALT_MAX = 300;

const PLAN_RULES: ImageRules = {
  field: "plan",
  maxBytes: FLOOR_PLAN_MAX_MB * 1024 * 1024,
  types: ["image/jpeg", "image/png", "image/webp"],
  empty: "Bitte ein Bild des Grundrisses auswählen",
  tooBig: `Das Bild ist zu groß (höchstens ${FLOOR_PLAN_MAX_MB} MB)`,
  wrongType: "Nur Bilder im Format JPEG, PNG oder WebP – ein PDF bitte vorher als PNG exportieren",
};

/** Grundriss hochladen, ersetzen, löschen und Räume verorten: Stammdaten-Recht (rs-3, nicht die Raumverantwortlichen). */
export function canEditFloorPlans(viewer: PermissionSet): boolean {
  return hasPermission(viewer, "verwaltung.school");
}

function requireEdit(viewer: PermissionSet) {
  if (!canEditFloorPlans(viewer)) throw new ForbiddenError("verwaltung.school");
}

/** Wer Grundrisse sieht: Beschäftigte immer, Schüler:innen/Eltern nur mit der Vorgabe „alle“ (rs-2). */
export async function canViewFloorPlans(db: Db, viewer: PermissionSet): Promise<boolean> {
  if (roomAudience(viewer) === "personal") return true;
  return (await readModuleSetting(db, FLOOR_PLAN_VISIBILITY)) === "alle";
}

/** Rein: Alternativtext wie gespeichert (Leerraum zusammengefasst); Pflichtfeld, 10–300 Zeichen. */
export function normalizePlanAlt(raw: string | null | undefined): string {
  const alt = (raw ?? "").replace(/\s+/g, " ").trim();
  if (alt.length < FLOOR_PLAN_ALT_MIN)
    throw new ValidationError({ alt: `Bitte beschreiben, was der Plan zeigt (mindestens ${FLOOR_PLAN_ALT_MIN} Zeichen), z. B. „Flur von West nach Ost, Treppenhaus in der Mitte“` });
  if (alt.length > FLOOR_PLAN_ALT_MAX) throw new ValidationError({ alt: `Alternativtext höchstens ${FLOOR_PLAN_ALT_MAX} Zeichen` });
  return alt;
}

/**
 * Rein: Koordinate aus dem Formular – Prozent (0–100, Komma oder Punkt) → Anteil 0–1, auf 4 Nachkommastellen gerundet.
 * Leer = kein Punkt. Wirft bei Text oder außerhalb des Bereichs.
 */
export function parsePlanPercent(raw: string | null | undefined, field: "x" | "y"): number | null {
  const t = (raw ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new ValidationError({ [field]: `${field === "x" ? "Von links" : "Von oben"}: 0 bis 100 Prozent` });
  return Math.round(n * 100) / 10_000;
}

export interface FloorPlanMeta {
  floorId: string;
  floor: string;
  buildingId: string;
  building: string;
  width: number;
  height: number;
  alt: string;
  /** für den Cache-Schlüssel der Bild-URL (ein ersetzter Plan bekommt eine neue URL) */
  version: number;
}

export interface FloorPlanRoom {
  id: string;
  name: string;
  active: boolean;
  x: number | null;
  y: number | null;
}

export interface FloorPlanView extends FloorPlanMeta {
  rooms: FloorPlanRoom[];
}

const metaCols = {
  floorId: buildingFloors.id,
  floor: buildingFloors.name,
  buildingId: buildings.id,
  building: buildings.name,
  width: buildingFloors.planWidth,
  height: buildingFloors.planHeight,
  alt: buildingFloors.planAlt,
  updatedAt: buildingFloors.planUpdatedAt,
};

type MetaRow = { floorId: string; floor: string; buildingId: string; building: string; width: number | null; height: number | null; alt: string | null; updatedAt: Date | null };

const toMeta = (r: MetaRow): FloorPlanMeta => ({
  floorId: r.floorId,
  floor: r.floor,
  buildingId: r.buildingId,
  building: r.building,
  width: r.width!,
  height: r.height!,
  alt: r.alt!,
  version: r.updatedAt!.getTime(),
});

async function floorRow(db: Db, floorId: string) {
  const [f] = await db.select().from(buildingFloors).where(eq(buildingFloors.id, floorId));
  return f ?? null;
}

/**
 * Grundrisse mehrerer Etagen mit ihren aktiven, verorteten Räumen – für den Raumfinder und „Lage“ im Steckbrief. Liefert nur
 * Etagen mit Plan und nur, wenn die Sicht Grundrisse sehen darf (sonst eine leere Map).
 */
export async function floorPlansFor(db: Db, viewer: PermissionSet, floorIds: string[]): Promise<Map<string, FloorPlanView>> {
  const ids = [...new Set(floorIds)];
  if (ids.length === 0 || !(await canViewFloorPlans(db, viewer))) return new Map();
  const metas = await db
    .select(metaCols)
    .from(buildingFloors)
    .innerJoin(buildings, eq(buildings.id, buildingFloors.buildingId))
    .where(and(inArray(buildingFloors.id, ids), isNotNull(buildingFloors.planKey)));
  if (metas.length === 0) return new Map();
  const points = await db
    .select({ id: rooms.id, name: rooms.name, active: rooms.active, x: rooms.planX, y: rooms.planY, floorId: rooms.floorId })
    .from(rooms)
    .where(and(inArray(rooms.floorId, metas.map((m) => m.floorId)), eq(rooms.active, true), isNotNull(rooms.planX)))
    .orderBy(asc(rooms.id));
  return new Map(
    metas.map((m) => [
      m.floorId,
      {
        ...toMeta(m),
        rooms: points
          .filter((p) => p.floorId === m.floorId)
          .sort((a, b) => a.id.localeCompare(b.id, "de", { numeric: true }))
          .map((p) => ({ id: p.id, name: p.name, active: p.active, x: p.x, y: p.y })),
      },
    ]),
  );
}

/** Pflegeansicht einer Etage: Plan (falls vorhanden) und alle Räume der Etage, auch stillgelegte und unverortete. */
export async function floorPlanEditor(db: Db, viewer: PermissionSet, floorId: string) {
  requireEdit(viewer);
  const [f] = await db
    .select({ ...metaCols, hasPlan: buildingFloors.planKey })
    .from(buildingFloors)
    .innerJoin(buildings, eq(buildings.id, buildingFloors.buildingId))
    .where(eq(buildingFloors.id, floorId));
  if (!f) return null;
  const list = await db
    .select({ id: rooms.id, name: rooms.name, active: rooms.active, x: rooms.planX, y: rooms.planY })
    .from(rooms)
    .where(eq(rooms.floorId, floorId));
  return {
    floorId: f.floorId,
    floor: f.floor,
    buildingId: f.buildingId,
    building: f.building,
    plan: f.hasPlan ? toMeta(f) : null,
    rooms: list.sort((a, b) => a.id.localeCompare(b.id, "de", { numeric: true })) as FloorPlanRoom[],
  };
}

/**
 * Lädt den Grundriss einer Etage hoch bzw. ersetzt ihn (ein Plan je Etage, rs-5): Typ an den Bytes, Metadaten weg, verkleinert
 * auf 2400 px (Vorschau 800 px), Virenscan. Die Punkte der Räume bleiben beim Ersetzen stehen (Hinweis auf der Pflegeseite).
 */
export async function setFloorPlan(db: Db, storage: FileStorage, viewer: PermissionSet, floorId: string, input: { image: Uint8Array; alt: string }): Promise<void> {
  requireEdit(viewer);
  const old = await floorRow(db, floorId);
  if (!old) throw new ValidationError({ plan: "Etage gibt es nicht" });
  const alt = normalizePlanAlt(input.alt);
  const clean = cleanImage(input.image, PLAN_RULES);
  const [full, thumb] = await Promise.all([resizeToJpeg(clean.data, FLOOR_PLAN_EDGE, 88), resizeToJpeg(clean.data, FLOOR_PLAN_THUMB_EDGE, 80)]).catch(() => {
    throw new ValidationError({ plan: "Das Bild lässt sich nicht lesen – bitte als PNG oder JPEG speichern und erneut hochladen" });
  });
  await scanUpload(full.data, "Grundriss", "plan");
  // Dateien zuerst; bricht danach etwas ab, räumt der Dateispeicher-Lauf sie weg (sweepOrphanFiles)
  const key = newStorageKey();
  const thumbKey = newStorageKey();
  await storage.put(key, full.data);
  await storage.put(thumbKey, thumb.data);
  await db
    .update(buildingFloors)
    .set({
      planKey: key,
      planThumbKey: thumbKey,
      planMime: full.mime,
      planWidth: full.size.width,
      planHeight: full.size.height,
      planAlt: alt,
      planUpdatedAt: new Date(),
    })
    .where(eq(buildingFloors.id, floorId));
  await audit(db, viewer.userId, old.planKey ? "verwaltung.room.floor.plan_replace" : "verwaltung.room.floor.plan_add", floorId, { name: old.name, buildingId: old.buildingId });
  if (old.planKey) await storage.delete(old.planKey).catch(() => {});
  if (old.planThumbKey) await storage.delete(old.planThumbKey).catch(() => {});
}

export async function setFloorPlanAlt(db: Db, viewer: PermissionSet, floorId: string, raw: string): Promise<void> {
  requireEdit(viewer);
  const old = await floorRow(db, floorId);
  if (!old?.planKey) throw new ValidationError({ alt: "Für diese Etage gibt es keinen Grundriss" });
  const alt = normalizePlanAlt(raw);
  if (alt === old.planAlt) return;
  await db.update(buildingFloors).set({ planAlt: alt }).where(eq(buildingFloors.id, floorId));
  await audit(db, viewer.userId, "verwaltung.room.floor.plan_alt", floorId, { name: old.name, buildingId: old.buildingId });
}

/** Löscht den Grundriss samt Dateien; die Punkte der Räume auf dieser Etage werden geleert. */
export async function deleteFloorPlan(db: Db, storage: FileStorage, viewer: PermissionSet, floorId: string): Promise<void> {
  requireEdit(viewer);
  const old = await floorRow(db, floorId);
  if (!old?.planKey) return;
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx
      .update(buildingFloors)
      .set({ planKey: null, planThumbKey: null, planMime: null, planWidth: null, planHeight: null, planAlt: null, planUpdatedAt: null })
      .where(eq(buildingFloors.id, floorId));
    await tx.update(rooms).set({ planX: null, planY: null }).where(eq(rooms.floorId, floorId));
    await audit(tx, viewer.userId, "verwaltung.room.floor.plan_delete", floorId, { name: old.name, buildingId: old.buildingId });
  });
  await storage.delete(old.planKey).catch(() => {});
  if (old.planThumbKey) await storage.delete(old.planThumbKey).catch(() => {});
}

/**
 * Setzt bzw. entfernt (`null`) den Punkt eines Raums auf dem Grundriss seiner Etage. Koordinaten 0–1 relativ zur Bildgröße;
 * der Raum muss auf einer Etage mit Plan liegen.
 */
export async function setRoomPlanPoint(db: Db, viewer: PermissionSet, roomId: string, point: { x: number; y: number } | null): Promise<void> {
  requireEdit(viewer);
  const [r] = await db
    .select({ id: rooms.id, floorId: rooms.floorId, x: rooms.planX, y: rooms.planY, hasPlan: buildingFloors.planKey })
    .from(rooms)
    .leftJoin(buildingFloors, eq(buildingFloors.id, rooms.floorId))
    .where(eq(rooms.id, roomId));
  if (!r) throw new ValidationError({ room: `Raum ${roomId} gibt es nicht` });
  if (point) {
    if (!r.floorId || !r.hasPlan) throw new ValidationError({ room: `Raum ${roomId} liegt auf keiner Etage mit Grundriss` });
    const fe: Record<string, string> = {};
    if (!Number.isFinite(point.x) || point.x < 0 || point.x > 1) fe.x = "Von links: 0 bis 100 Prozent";
    if (!Number.isFinite(point.y) || point.y < 0 || point.y > 1) fe.y = "Von oben: 0 bis 100 Prozent";
    if (Object.keys(fe).length) throw new ValidationError(fe);
  }
  const x = point ? point.x : null;
  const y = point ? point.y : null;
  if (x === r.x && y === r.y) return;
  await db.update(rooms).set({ planX: x, planY: y }).where(eq(rooms.id, roomId));
  await audit(db, viewer.userId, point ? "verwaltung.room.plan_point" : "verwaltung.room.plan_point_remove", roomId, { floorId: r.floorId });
}

/**
 * Plan-Datei für die Auslieferung (Route /api/raeume/grundriss/[etage]): nur mit Sicht auf Grundrisse (Moduleinstellung) und
 * nur, wenn die Etage einen Plan hat. null = nicht vorhanden oder nicht sichtbar (die Route antwortet einheitlich 404).
 */
export async function floorPlanFile(db: Db, viewer: PermissionSet, floorId: string, small: boolean): Promise<{ key: string; mime: string } | null> {
  const f = await floorRow(db, floorId);
  if (!f?.planKey || !f.planThumbKey || !f.planMime) return null;
  if (!(await canViewFloorPlans(db, viewer))) return null;
  return { key: small ? f.planThumbKey : f.planKey, mime: f.planMime };
}
