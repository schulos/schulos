// Gebäude & Technik (P4-15/P4-16/P4-18): Anlagen/Geräte, Prüfarten (Vorlage pruefarten.ts, Q-23), Prüfungen mit
// Fälligkeiten, Fristen-Job „gebaeude-fristen“, Prüfliste/CSV/Statistik. Kein Personenbezug: Prüfungen nennen eine Firma,
// wer erfasst hat, steht nur im Audit-Log; Auswertungen nur je Kategorie/Monat (DATENSCHUTZ §5).
import { scanUpload } from "@/modules/upload-scan";
import { and, asc, between, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { MailConfig, MailMessage, Sender } from "@schulos/server/mail";
import { smtpSender } from "@schulos/server/mail";
import { audit } from "@/core/audit";
import { toCsv } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { buildingFloors, buildings, gebaeudeAssetCategories, gebaeudeAssetPhotos, gebaeudeAssets, gebaeudeInspectionTypes, gebaeudeInspections, gebaeudeTickets, labelCodes, rooms } from "@/core/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { canMaintainInventory, categoryById, ensureCategories, inventoryNoFormat, maintainableCategories, nextInventoryNo, requireMaintain } from "./inventar";
import { hasOpenLoan } from "./leihe";
import {
  ASSET_CONDITIONS,
  CATEGORY_LABELS,
  INSPECTION_RESPONSIBLES,
  INSPECTION_RESULTS,
  INSPECTION_STATE_LABELS,
  INSPECTION_TARGETS,
  MAX_REPORT_MB,
  PRIORITY_LABELS,
  RESULT_LABELS,
  STATUS_LABELS,
  TICKET_CATEGORIES,
  ticketNumber,
  ticketCategoryForAsset,
  parsePriceCents,
  type AssetCondition,
  type InspectionResponsible,
  type InspectionResult,
  type InspectionState,
  type InspectionTarget,
  type TicketCategory,
} from "./labels";
import { INSPECTION_TEMPLATE } from "./pruefarten";
import { canManage, canViewAll, createTicket, placeLabel } from "./service";

const MODULE = "gebaeude";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const canConfigure = (p: PermissionSet) => hasPermission(p, "gebaeude.configure");

function requireViewAll(p: PermissionSet) {
  if (!canViewAll(p)) throw new ForbiddenError("gebaeude.view_all");
}
/** Inventar lesen: wer alles lesen oder das Inventar pflegen darf (Code-Review Gate 4a N5; verantwortliche Gruppen prüft `listAssets`). */
export const canSeeAssets = (p: PermissionSet) => canViewAll(p) || canMaintainInventory(p);
function requireManage(p: PermissionSet) {
  if (!canManage(p)) throw new ForbiddenError("gebaeude.manage");
}
function requireConfigure(p: PermissionSet) {
  if (!canConfigure(p)) throw new ForbiddenError("gebaeude.configure");
}

// ---------------------------------------------------------------- Fristen (rein)

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Rein: Kalendermonate addieren; fehlt der Tag im Zielmonat, gilt der Monatsletzte
 * (31.01. + 1 Monat = 28./29.02., 29.02.2024 + 12 Monate = 28.02.2025).
 */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12; // 0-basiert
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(d!, last))}`;
}

/** Rein: Stand einer Prüfung am Tag `today` – überfällig (Termin vorbei), bald fällig (in der Vorwarnzeit), geplant, erledigt. */
export function inspectionState(i: { dueOn: string; doneOn: string | null }, warnDays: number, today: string): InspectionState {
  if (i.doneOn) return "erledigt";
  if (i.dueOn < today) return "ueberfaellig";
  if (i.dueOn <= addDays(today, warnDays)) return "faellig";
  return "geplant";
}

/** Erinnerung „bald fällig“ höchstens einmal je Woche, „überfällig“ einmal je Kalendertag. */
export const REMIND_DUE_EVERY_DAYS = 7;

/** Rein: braucht die offene Prüfung jetzt eine Erinnerung? */
export function reminderDue(state: InspectionState, remindedAt: Date | null, now: Date): boolean {
  if (state === "ueberfaellig") return !remindedAt || toBerlinDate(remindedAt) < toBerlinDate(now);
  if (state === "faellig") return !remindedAt || now.getTime() - remindedAt.getTime() >= REMIND_DUE_EVERY_DAYS * 86_400_000 - 60 * 60_000;
  return false;
}

/** Rein: echtes PDF? Prüft die Signatur „%PDF-“ am Dateianfang (Magic Bytes), nicht Endung oder Browser-Typ. */
export function isPdf(bytes: Uint8Array): boolean {
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  return bytes.length > sig.length && sig.every((b, i) => bytes[i] === b);
}

// ---------------------------------------------------------------- Prüfarten

/**
 * Vorlage einspielen (fehlende Einträge, ausgeschaltet). Bestehende – auch angepasste – bleiben unverändert. Die Kategorie der
 * Vorlage (INV-01: `categoryKey`) wird über die Kategorien-Tabelle aufgelöst (Vorlage dort zuerst sicherstellen).
 */
export async function ensureTemplate(db: Db): Promise<void> {
  await ensureCategories(db);
  const cats = new Map((await db.select({ id: gebaeudeAssetCategories.id, key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories)).map((c) => [c.key, c.id]));
  await db
    .insert(gebaeudeInspectionTypes)
    .values(
      INSPECTION_TEMPLATE.map((t) => ({
        templateKey: t.key,
        name: t.name,
        appliesTo: t.appliesTo,
        categoryId: t.categoryKey ? (cats.get(t.categoryKey) ?? null) : null,
        intervalMonths: t.intervalMonths,
        warnDays: t.warnDays,
        source: t.source,
        responsible: t.responsible,
        note: t.note,
        active: false,
      })),
    )
    .onConflictDoNothing({ target: gebaeudeInspectionTypes.templateKey });
}

export async function listInspectionTypes(db: Db, opts: { activeOnly?: boolean } = {}) {
  await ensureTemplate(db);
  const rows = await db
    .select({
      id: gebaeudeInspectionTypes.id,
      templateKey: gebaeudeInspectionTypes.templateKey,
      name: gebaeudeInspectionTypes.name,
      appliesTo: gebaeudeInspectionTypes.appliesTo,
      categoryId: gebaeudeInspectionTypes.categoryId,
      categoryName: gebaeudeAssetCategories.name,
      intervalMonths: gebaeudeInspectionTypes.intervalMonths,
      warnDays: gebaeudeInspectionTypes.warnDays,
      source: gebaeudeInspectionTypes.source,
      responsible: gebaeudeInspectionTypes.responsible,
      note: gebaeudeInspectionTypes.note,
      active: gebaeudeInspectionTypes.active,
      createdAt: gebaeudeInspectionTypes.createdAt,
    })
    .from(gebaeudeInspectionTypes)
    .leftJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeInspectionTypes.categoryId))
    .where(opts.activeOnly ? eq(gebaeudeInspectionTypes.active, true) : undefined)
    .orderBy(desc(gebaeudeInspectionTypes.active), asc(gebaeudeInspectionTypes.createdAt), asc(gebaeudeInspectionTypes.name));
  return rows;
}

export interface InspectionTypeInput {
  name: string;
  appliesTo: string;
  /** Kategorie, deren aktive Anlagen automatisch geplant werden (nur bei Bezug „anlage“) */
  categoryId: string | null;
  intervalMonths: number;
  warnDays: number;
  source: string;
  responsible: string;
  note: string | null;
  active: boolean;
}

async function validateType(db: Db, input: InspectionTypeInput) {
  const fe: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 3 || name.length > 120) fe.name = "Name mit 3 bis 120 Zeichen";
  if (!(INSPECTION_TARGETS as readonly string[]).includes(input.appliesTo)) fe.appliesTo = "Bezug wählen";
  const categoryId = input.appliesTo === "anlage" && input.categoryId?.trim() ? input.categoryId.trim() : null;
  if (categoryId && !(await categoryById(db, categoryId))) fe.categoryId = "Kategorie wählen";
  if (!Number.isInteger(input.intervalMonths) || input.intervalMonths < 1 || input.intervalMonths > 120) fe.intervalMonths = "Intervall 1 bis 120 Monate";
  if (!Number.isInteger(input.warnDays) || input.warnDays < 0 || input.warnDays > 365) fe.warnDays = "Vorwarnzeit 0 bis 365 Tage";
  if (input.source.trim().length > 300) fe.source = "höchstens 300 Zeichen";
  if (!(INSPECTION_RESPONSIBLES as readonly string[]).includes(input.responsible)) fe.responsible = "Zuständigkeit wählen";
  const note = input.note?.trim() || null;
  if (note && note.length > 500) fe.note = "höchstens 500 Zeichen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    name,
    appliesTo: input.appliesTo as InspectionTarget,
    categoryId,
    intervalMonths: input.intervalMonths,
    warnDays: input.warnDays,
    source: input.source.trim(),
    responsible: input.responsible as InspectionResponsible,
    note,
    active: input.active,
  };
}

/** Prüfart anpassen bzw. ein-/ausschalten (Recht `gebaeude.configure`). Eingeschaltet → Prüfungen für passende Anlagen planen. */
export async function updateInspectionType(db: Db, viewer: PermissionSet, id: string, input: InspectionTypeInput, today: string): Promise<void> {
  requireConfigure(viewer);
  const row = await validateType(db, input);
  const [old] = await db.select().from(gebaeudeInspectionTypes).where(eq(gebaeudeInspectionTypes.id, id));
  if (!old) throw new ValidationError({ name: "Prüfart gibt es nicht" });
  // Bezug ändert sich nicht, sobald es Prüfungen gibt (sonst passen Ziele nicht mehr)
  if (old.appliesTo !== row.appliesTo) {
    const [any] = await db.select({ id: gebaeudeInspections.id }).from(gebaeudeInspections).where(eq(gebaeudeInspections.typeId, id)).limit(1);
    if (any) throw new ValidationError({ appliesTo: "Es gibt schon Prüfungen dieser Art – Bezug bleibt" });
  }
  await db.update(gebaeudeInspectionTypes).set(row).where(eq(gebaeudeInspectionTypes.id, id));
  await audit(db, viewer.userId, "gebaeude.inspection_type.update", id, { name: row.name, active: row.active, intervalMonths: row.intervalMonths });
  await planDue(db, today);
}

/** Eigene Prüfart anlegen (Recht `gebaeude.configure`), gleich eingeschaltet. */
export async function createInspectionType(db: Db, viewer: PermissionSet, input: InspectionTypeInput, today: string): Promise<string> {
  requireConfigure(viewer);
  const row = await validateType(db, input);
  const [r] = await db.insert(gebaeudeInspectionTypes).values(row).returning({ id: gebaeudeInspectionTypes.id });
  await audit(db, viewer.userId, "gebaeude.inspection_type.create", r!.id, { name: row.name });
  await planDue(db, today);
  return r!.id;
}

// ---------------------------------------------------------------- Inventar (INV-01)

export interface AssetInput {
  name: string;
  categoryId: string;
  roomId: string | null;
  /** Standort ohne Raum (oder abweichend): Gebäude/Etage aus den Stammdaten */
  buildingId?: string | null;
  floorId?: string | null;
  /** leer = automatisch aus dem Zähler der Kategorie */
  inventoryNo: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serial?: string | null;
  condition?: string | null;
  /** Sammelposten: Menge > 1 (Tische, Stühle je Raum) */
  quantity?: string | number | null;
  /** Preis als Text („1.234,56“) */
  price?: string | null;
  supplier?: string | null;
  financing?: string | null;
  boundUntil?: string | null;
  warrantyUntil?: string | null;
  acquiredOn?: string | null;
  note?: string | null;
}

async function validateAsset(db: Db, input: AssetInput, selfId?: string) {
  const fe: Record<string, string> = {};
  const t = (s: string | null | undefined) => s?.trim() || null;
  const name = input.name.trim();
  const roomId = t(input.roomId);
  const buildingId = t(input.buildingId);
  const floorId = t(input.floorId);
  const inventoryNo = t(input.inventoryNo);
  const condition = t(input.condition);
  const quantity = input.quantity === null || input.quantity === undefined || String(input.quantity).trim() === "" ? 1 : Number(String(input.quantity).trim());
  const priceCents = parsePriceCents(input.price);
  if (name.length < 2 || name.length > 120) fe.name = "Bezeichnung mit 2 bis 120 Zeichen";
  const category = await categoryById(db, input.categoryId);
  if (!category) fe.categoryId = "Kategorie wählen";
  for (const [k, v, n] of [
    ["inventoryNo", inventoryNo, 40],
    ["manufacturer", t(input.manufacturer), 80],
    ["model", t(input.model), 80],
    ["serial", t(input.serial), 80],
    ["supplier", t(input.supplier), 120],
    ["financing", t(input.financing), 120],
    ["note", t(input.note), 500],
  ] as const)
    if (v && v.length > n) fe[k] = `höchstens ${n} Zeichen`;
  if (condition && !(ASSET_CONDITIONS as readonly string[]).includes(condition)) fe.condition = "Zustand wählen";
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) fe.quantity = "Menge 1 bis 9999";
  if (Number.isNaN(priceCents)) fe.price = "Preis in Euro, z. B. 1.234,56";
  else if (priceCents !== null && priceCents > 99_999_999_00) fe.price = "Preis zu hoch";
  for (const [k, v] of [
    ["acquiredOn", t(input.acquiredOn)],
    ["boundUntil", t(input.boundUntil)],
    ["warrantyUntil", t(input.warrantyUntil)],
  ] as const)
    if (v && !YMD.test(v)) fe[k] = "Datum angeben";
  if (roomId) {
    const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
    if (!r) fe.roomId = "Raum gibt es nicht";
  }
  if (buildingId) {
    const [b] = await db.select({ id: buildings.id }).from(buildings).where(eq(buildings.id, buildingId));
    if (!b) fe.buildingId = "Gebäude gibt es nicht";
  }
  if (floorId) {
    const [f] = await db.select({ buildingId: buildingFloors.buildingId }).from(buildingFloors).where(eq(buildingFloors.id, floorId));
    if (!f || (buildingId && f.buildingId !== buildingId)) fe.floorId = "Etage passt nicht zum Gebäude";
  }
  if (inventoryNo) {
    const [dup] = await db.select({ id: gebaeudeAssets.id }).from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, inventoryNo));
    if (dup && dup.id !== selfId) fe.inventoryNo = "Inventarnummer ist schon vergeben";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    name,
    categoryId: category!.id,
    roomId,
    buildingId: floorId && !buildingId ? null : buildingId,
    floorId,
    inventoryNo,
    manufacturer: t(input.manufacturer),
    model: t(input.model),
    serial: t(input.serial),
    condition: condition as AssetCondition | null,
    quantity,
    priceCents,
    supplier: t(input.supplier),
    financing: t(input.financing),
    boundUntil: t(input.boundUntil),
    warrantyUntil: t(input.warrantyUntil),
    acquiredOn: t(input.acquiredOn),
    note: t(input.note),
    category: category!,
  };
}

/** Anlegen (Recht `gebaeude.inventory`/`configure` oder verantwortliche Gruppe der Kategorie); ohne Nummer vergibt der Zähler eine. */
export async function createAsset(db: Db, viewer: PermissionSet, input: AssetInput, today: string): Promise<string> {
  const { category, ...row } = await validateAsset(db, input);
  await requireMaintain(db, viewer, category.id);
  const format = await inventoryNoFormat(db);
  const id = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const inventoryNo = row.inventoryNo ?? (await nextInventoryNo(tx, category.prefix, format, today));
    const [r] = await tx.insert(gebaeudeAssets).values({ ...row, inventoryNo }).returning({ id: gebaeudeAssets.id });
    return r!.id;
  });
  await audit(db, viewer.userId, "gebaeude.asset.create", id, { name: row.name, category: category.key });
  await planDue(db, today);
  return id;
}

/** Ändern (gleiche Rechte wie Anlegen, für alte und neue Kategorie). Wechselt die Kategorie, entfallen offene Prüfungen fremder Prüfarten. */
export async function updateAsset(db: Db, viewer: PermissionSet, id: string, input: AssetInput, today: string): Promise<void> {
  const [old] = await db.select({ categoryId: gebaeudeAssets.categoryId, inventoryNo: gebaeudeAssets.inventoryNo }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, id));
  if (!old) throw new ValidationError({ name: "Inventar gibt es nicht" });
  await requireMaintain(db, viewer, old.categoryId);
  const { category, ...row } = await validateAsset(db, input, id);
  if (category.id !== old.categoryId) await requireMaintain(db, viewer, category.id);
  // leere Nummer im Formular: bisherige bleibt; gab es nie eine, vergibt der Zähler jetzt eine
  const inventoryNo = row.inventoryNo ?? old.inventoryNo ?? (await nextInventoryNo(db, category.prefix, await inventoryNoFormat(db), today));
  await db.update(gebaeudeAssets).set({ ...row, inventoryNo }).where(eq(gebaeudeAssets.id, id));
  if (category.id !== old.categoryId) {
    await db.delete(gebaeudeInspections).where(
      and(
        eq(gebaeudeInspections.assetId, id),
        isNull(gebaeudeInspections.doneOn),
        sql`${gebaeudeInspections.typeId} in (select t.id from gebaeude_inspection_types t where t.category_id is not null and t.category_id <> ${category.id})`,
      ),
    );
  }
  await audit(db, viewer.userId, "gebaeude.asset.update", id, { name: row.name, category: category.key });
  await planDue(db, today);
}

/**
 * Ausmustern (offene Prüfungen entfallen, bleibt als Nachweis, in der Liste ausgeblendet – inv-8) bzw. wieder in Betrieb nehmen
 * (Prüfungen werden neu geplant). Rechte wie beim Anlegen.
 */
export async function setAssetActive(db: Db, viewer: PermissionSet, id: string, active: boolean, today: string, reason: string | null = null): Promise<void> {
  const [a] = await db.select({ categoryId: gebaeudeAssets.categoryId }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, id));
  if (!a) throw new ValidationError({ asset: "Inventar gibt es nicht" });
  await requireMaintain(db, viewer, a.categoryId);
  // INV-05: ein verliehenes Gerät erst zurücknehmen, dann ausmustern (sonst bliebe die Ausleihe ohne Gerät in Betrieb offen)
  if (!active && (await hasOpenLoan(db, id))) throw new ValidationError({ asset: "Das Gerät ist verliehen – erst die Rückgabe buchen" });
  const retiredReason = reason?.trim().slice(0, 200) || null;
  await db
    .update(gebaeudeAssets)
    .set(active ? { active: true, retiredOn: null, retiredReason: null } : { active: false, retiredOn: today, retiredReason })
    .where(eq(gebaeudeAssets.id, id));
  if (!active) await db.delete(gebaeudeInspections).where(and(eq(gebaeudeInspections.assetId, id), isNull(gebaeudeInspections.doneOn)));
  await audit(db, viewer.userId, active ? "gebaeude.asset.activate" : "gebaeude.asset.deactivate", id);
  if (active) await planDue(db, today);
}

/**
 * Ausgemustertes Inventar endgültig löschen (Recht `gebaeude.configure`; Etikett-Code, Prüfungen und Fotos gehen mit, Meldungen
 * bleiben ohne Bezug). Fotodateien löscht `storage` direkt; ohne bzw. bei Fehlern räumt der Dateispeicher-Lauf sie weg.
 */
export async function deleteAsset(db: Db, viewer: PermissionSet, id: string, storage?: FileStorage): Promise<void> {
  requireConfigure(viewer);
  const [a] = await db.select({ name: gebaeudeAssets.name, active: gebaeudeAssets.active }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, id));
  if (!a) throw new ValidationError({ asset: "Inventar gibt es nicht" });
  if (a.active) throw new ValidationError({ asset: "Nur ausgemustertes Inventar lässt sich löschen" });
  const files = await db.select({ key: gebaeudeAssetPhotos.storageKey, thumb: gebaeudeAssetPhotos.thumbKey }).from(gebaeudeAssetPhotos).where(eq(gebaeudeAssetPhotos.assetId, id));
  await db.delete(gebaeudeAssets).where(eq(gebaeudeAssets.id, id));
  await audit(db, viewer.userId, "gebaeude.asset.delete", id, { name: a.name });
  if (storage) for (const f of files) for (const k of [f.key, f.thumb]) await storage.delete(k).catch(() => {});
}

/** Gebäude/Etage des Inventars: direkt gesetzt oder über den Raum. */
const assetBuildings = alias(buildings, "asset_buildings");
const assetFloors = alias(buildingFloors, "asset_floors");
const assetBuildingId = sql<string | null>`coalesce(${gebaeudeAssets.buildingId}, ${rooms.buildingId})`;
const assetBuilding = sql<string | null>`coalesce(${assetBuildings.name}, ${rooms.building})`;
const assetFloor = sql<string | null>`coalesce(${assetFloors.name}, ${rooms.floor})`;

export interface AssetFilter {
  categoryId?: string;
  buildingId?: string;
  roomId?: string;
  condition?: string;
  /** auch ausgemusterte */
  inactive?: boolean;
  /** nur ohne Etikett-Code */
  withoutLabel?: boolean;
  /** Suche in Bezeichnung, Inventarnummer, Seriennummer, Hersteller, Modell */
  q?: string;
  /** INV-06: Garantie bzw. Zweckbindung endet im Zeitraum [from, until] (Hinweis in „Offen für dich“) */
  deadline?: { kind: "garantie" | "zweckbindung"; from: string; until: string };
}

const assetColumns = {
  id: gebaeudeAssets.id,
  name: gebaeudeAssets.name,
  categoryId: gebaeudeAssets.categoryId,
  categoryKey: gebaeudeAssetCategories.key,
  categoryName: gebaeudeAssetCategories.name,
  categorySort: gebaeudeAssetCategories.sortOrder,
  roomId: gebaeudeAssets.roomId,
  roomName: rooms.name,
  buildingId: assetBuildingId,
  building: assetBuilding,
  floor: assetFloor,
  inventoryNo: gebaeudeAssets.inventoryNo,
  manufacturer: gebaeudeAssets.manufacturer,
  model: gebaeudeAssets.model,
  serial: gebaeudeAssets.serial,
  condition: gebaeudeAssets.condition,
  quantity: gebaeudeAssets.quantity,
  priceCents: gebaeudeAssets.priceCents,
  supplier: gebaeudeAssets.supplier,
  financing: gebaeudeAssets.financing,
  boundUntil: gebaeudeAssets.boundUntil,
  warrantyUntil: gebaeudeAssets.warrantyUntil,
  acquiredOn: gebaeudeAssets.acquiredOn,
  active: gebaeudeAssets.active,
  retiredOn: gebaeudeAssets.retiredOn,
  retiredReason: gebaeudeAssets.retiredReason,
  note: gebaeudeAssets.note,
  labelCode: labelCodes.code,
  nextDue: sql<string | null>`(select min(i.due_on)::text from gebaeude_inspections i where i.asset_id = ${gebaeudeAssets.id} and i.done_on is null)`,
};

function assetQuery(db: Db) {
  return db
    .select(assetColumns)
    .from(gebaeudeAssets)
    .innerJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId))
    .leftJoin(rooms, eq(rooms.id, gebaeudeAssets.roomId))
    .leftJoin(assetBuildings, eq(assetBuildings.id, gebaeudeAssets.buildingId))
    .leftJoin(assetFloors, eq(assetFloors.id, gebaeudeAssets.floorId))
    .leftJoin(labelCodes, and(eq(labelCodes.kind, "inventar"), eq(labelCodes.assetId, gebaeudeAssets.id)));
}

export type AssetRow = Awaited<ReturnType<typeof listAssets>>[number];

/** Rein: Standort als Text („Raum 112 · Hauptgebäude · 1. OG“). */
export function assetPlace(a: { roomId: string | null; building: string | null; floor: string | null }): string {
  return [a.roomId ? `Raum ${a.roomId}` : null, a.building, a.floor].filter(Boolean).join(" · ") || "ohne Standort";
}

/**
 * Inventarliste: alle lesen mit `view_all`/`inventory`/`configure`; verantwortliche Gruppen sehen die Anlagen ihrer Kategorien.
 * Ausgemusterte nur mit `inactive`.
 */
export async function listAssets(db: Db, viewer: PermissionSet, f: AssetFilter = {}) {
  const own = canViewAll(viewer) ? null : await maintainableCategories(db, viewer);
  if (own && own.size === 0) throw new ForbiddenError("gebaeude.view_all");
  const q = f.q?.trim().toLowerCase();
  const rows = await assetQuery(db)
    .where(
      and(
        f.inactive ? undefined : eq(gebaeudeAssets.active, true),
        own ? inArray(gebaeudeAssets.categoryId, [...own]) : undefined,
        f.categoryId ? eq(gebaeudeAssets.categoryId, f.categoryId) : undefined,
        f.roomId ? eq(gebaeudeAssets.roomId, f.roomId) : undefined,
        f.buildingId ? sql`${assetBuildingId} = ${f.buildingId}` : undefined,
        f.condition && (ASSET_CONDITIONS as readonly string[]).includes(f.condition) ? eq(gebaeudeAssets.condition, f.condition as AssetCondition) : undefined,
        f.withoutLabel ? isNull(labelCodes.code) : undefined,
        f.deadline ? between(f.deadline.kind === "garantie" ? gebaeudeAssets.warrantyUntil : gebaeudeAssets.boundUntil, f.deadline.from, f.deadline.until) : undefined,
        q
          ? sql`(lower(${gebaeudeAssets.name}) like ${`%${q}%`} or lower(coalesce(${gebaeudeAssets.inventoryNo}, '')) like ${`%${q}%`} or lower(coalesce(${gebaeudeAssets.serial}, '')) like ${`%${q}%`} or lower(coalesce(${gebaeudeAssets.manufacturer}, '')) like ${`%${q}%`} or lower(coalesce(${gebaeudeAssets.model}, '')) like ${`%${q}%`})`
          : undefined,
      ),
    )
    .orderBy(asc(gebaeudeAssetCategories.sortOrder), asc(gebaeudeAssets.name))
    .limit(2000);
  return rows.sort((a, b) => a.categorySort - b.categorySort || a.categoryName.localeCompare(b.categoryName, "de") || a.name.localeCompare(b.name, "de", { numeric: true }));
}

/**
 * Ein Inventargut für die Asset-Seite (`/gebaeude/inventar/<id>`, Ziel von `/i/<code>`): Pflegende und `view_all` sehen alles,
 * alle anderen Angemeldeten nur Bezeichnung, Kategorie und Standort (inv-5) – `full` sagt, was gilt. `null` = unbekannt.
 */
export async function getAsset(db: Db, viewer: PermissionSet, id: string) {
  const [a] = await assetQuery(db).where(eq(gebaeudeAssets.id, id));
  if (!a) return null;
  const own = canViewAll(viewer) ? null : await maintainableCategories(db, viewer);
  const full = own === null || own.has(a.categoryId);
  const maintain = canMaintainInventory(viewer) || (own !== null && own.has(a.categoryId));
  if (full) return { asset: a, full: true as const, maintain };
  return {
    asset: { id: a.id, name: a.name, categoryId: a.categoryId, categoryKey: a.categoryKey, categoryName: a.categoryName, roomId: a.roomId, roomName: a.roomName, building: a.building, floor: a.floor, quantity: a.quantity, active: a.active },
    full: false as const,
    maintain: false,
  };
}

/** Gebäude aus den Stammdaten für Filter und Formulare (Reihenfolge wie in der Verwaltung). */
export async function buildingOptions(db: Db) {
  const rows = await db.select({ id: buildings.id, name: buildings.name, sortOrder: buildings.sortOrder }).from(buildings).orderBy(asc(buildings.sortOrder), asc(buildings.name));
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "de")).map((b) => ({ value: b.id, label: b.name }));
}

/** Etagen (Gebäude · Etage) für das Formular. */
export async function floorOptions(db: Db) {
  const rows = await db
    .select({ id: buildingFloors.id, name: buildingFloors.name, buildingId: buildingFloors.buildingId, building: buildings.name, bs: buildings.sortOrder, fs: buildingFloors.sortOrder })
    .from(buildingFloors)
    .innerJoin(buildings, eq(buildings.id, buildingFloors.buildingId));
  return rows
    .sort((a, b) => a.bs - b.bs || a.building.localeCompare(b.building, "de") || a.fs - b.fs || a.name.localeCompare(b.name, "de"))
    .map((f) => ({ value: f.id, label: `${f.building} · ${f.name}`, buildingId: f.buildingId }));
}

// ---------------------------------------------------------------- Inventarliste (CSV-Import/-Export: inventar-csv.ts, INV-06)

/** Rein: „2025-03-01“ oder „01.03.2025“ → „2025-03-01“; sonst null. */
export function parseDay(raw: string): string | null {
  const v = raw.trim();
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const ymd = YMD.test(v) ? v : m ? `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}` : null;
  if (!ymd) return null;
  // echtes Datum? (32.13. oder 30.02. fallen durch)
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, mo! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo! - 1 && dt.getUTCDate() === d ? ymd : null;
}

/**
 * „letzte Prüfung“ aus der Inventarliste übernehmen: Nachweis nur einmal (gleiches Datum → nichts Neues), und eine schon
 * geplante offene Prüfung rückt auf „letzte Prüfung + Intervall“, wenn sie früher lag – sonst bliebe sie nach einem ersten
 * Import ohne Datum dauerhaft überfällig (täglicher Alarm).
 */
export async function takeOverInspection(db: Db, t: { id: string; intervalMonths: number }, assetId: string, lastInspected: string) {
  const pair = and(eq(gebaeudeInspections.typeId, t.id), eq(gebaeudeInspections.assetId, assetId));
  const [same] = await db.select({ id: gebaeudeInspections.id }).from(gebaeudeInspections).where(and(pair, eq(gebaeudeInspections.doneOn, lastInspected)));
  if (!same) await db.insert(gebaeudeInspections).values({ typeId: t.id, assetId, dueOn: lastInspected, doneOn: lastInspected, note: "aus Inventarliste übernommen" });
  const [latest] = await db
    .select({ doneOn: gebaeudeInspections.doneOn })
    .from(gebaeudeInspections)
    .where(and(pair, isNotNull(gebaeudeInspections.doneOn)))
    .orderBy(desc(gebaeudeInspections.doneOn))
    .limit(1);
  const due = addMonths(latest?.doneOn ?? lastInspected, t.intervalMonths);
  await db
    .update(gebaeudeInspections)
    .set({ dueOn: due, remindedAt: null })
    .where(and(pair, isNull(gebaeudeInspections.doneOn), lt(gebaeudeInspections.dueOn, due)));
}

// ---------------------------------------------------------------- Planen

/**
 * Für jede eingeschaltete Prüfart mit Anlagen-Art und jede aktive Anlage dieser Art eine offene Prüfung sicherstellen:
 * fällig = letzte Prüfung + Intervall, sonst Anschaffung + Intervall, sonst sofort (heute).
 */
export async function planDue(db: Db, today: string): Promise<number> {
  const types = (await db.select().from(gebaeudeInspectionTypes).where(and(eq(gebaeudeInspectionTypes.active, true), isNotNull(gebaeudeInspectionTypes.categoryId)))).filter(
    (t) => t.appliesTo === "anlage",
  );
  if (!types.length) return 0;
  const assets = await db
    .select({ id: gebaeudeAssets.id, categoryId: gebaeudeAssets.categoryId, acquiredOn: gebaeudeAssets.acquiredOn })
    .from(gebaeudeAssets)
    .where(and(eq(gebaeudeAssets.active, true), inArray(gebaeudeAssets.categoryId, [...new Set(types.map((t) => t.categoryId!))])));
  if (!assets.length) return 0;
  const existing = await db
    .select({ typeId: gebaeudeInspections.typeId, assetId: gebaeudeInspections.assetId, doneOn: gebaeudeInspections.doneOn })
    .from(gebaeudeInspections)
    .where(inArray(gebaeudeInspections.typeId, types.map((t) => t.id)));
  const open = new Set(existing.filter((e) => !e.doneOn).map((e) => `${e.typeId}:${e.assetId}`));
  const lastDone = new Map<string, string>();
  for (const e of existing) {
    if (!e.doneOn) continue;
    const k = `${e.typeId}:${e.assetId}`;
    if (!lastDone.has(k) || lastDone.get(k)! < e.doneOn) lastDone.set(k, e.doneOn);
  }
  const values: (typeof gebaeudeInspections.$inferInsert)[] = [];
  for (const t of types) {
    for (const a of assets.filter((x) => x.categoryId === t.categoryId)) {
      const k = `${t.id}:${a.id}`;
      if (open.has(k)) continue;
      const base = lastDone.get(k) ?? a.acquiredOn;
      values.push({ typeId: t.id, assetId: a.id, dueOn: base ? addMonths(base, t.intervalMonths) : today });
    }
  }
  if (values.length) await db.insert(gebaeudeInspections).values(values);
  return values.length;
}

export interface PlanInput {
  typeId: string;
  assetId?: string | null;
  roomId?: string | null;
  building?: string | null;
  dueOn: string;
}

/** Prüfung von Hand planen (Recht `gebaeude.manage`) – für Raum- und Gebäudeprüfungen oder einen abweichenden Termin. */
export async function planInspection(db: Db, viewer: PermissionSet, input: PlanInput): Promise<string> {
  requireManage(viewer);
  const fe: Record<string, string> = {};
  const [type] = await db.select().from(gebaeudeInspectionTypes).where(eq(gebaeudeInspectionTypes.id, input.typeId));
  if (!type) fe.typeId = "Prüfart wählen";
  else if (!type.active) fe.typeId = "Prüfart ist ausgeschaltet";
  if (!YMD.test(input.dueOn)) fe.dueOn = "Fälligkeit angeben";
  const assetId = input.assetId?.trim() || null;
  const roomId = input.roomId?.trim() || null;
  const building = input.building?.trim() || null;
  const target = { assetId: null as string | null, roomId: null as string | null, building: null as string | null };
  if (type?.appliesTo === "anlage") {
    if (!assetId) fe.assetId = "Anlage wählen";
    else {
      const [a] = await db.select({ categoryId: gebaeudeAssets.categoryId, categoryName: gebaeudeAssetCategories.name, active: gebaeudeAssets.active }).from(gebaeudeAssets).innerJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId)).where(eq(gebaeudeAssets.id, assetId));
      if (!a || !a.active) fe.assetId = "Anlage gibt es nicht (oder außer Betrieb)";
      else if (type.categoryId && a.categoryId !== type.categoryId) fe.assetId = `Prüfart gilt für ${(await categoryById(db, type.categoryId))?.name ?? "eine andere Kategorie"}`;
    }
    target.assetId = assetId;
  } else if (type?.appliesTo === "raum") {
    if (!roomId) fe.roomId = "Raum wählen";
    else {
      const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
      if (!r) fe.roomId = "Raum gibt es nicht";
    }
    target.roomId = roomId;
  } else if (type) {
    if (!building) fe.building = "Gebäude angeben";
    else if (building.length > 60) fe.building = "höchstens 60 Zeichen";
    target.building = building;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const sameTarget = and(
    eq(gebaeudeInspections.typeId, input.typeId),
    isNull(gebaeudeInspections.doneOn),
    target.assetId ? eq(gebaeudeInspections.assetId, target.assetId) : isNull(gebaeudeInspections.assetId),
    target.roomId ? eq(gebaeudeInspections.roomId, target.roomId) : isNull(gebaeudeInspections.roomId),
    target.building ? eq(gebaeudeInspections.building, target.building) : isNull(gebaeudeInspections.building),
  );
  const [dup] = await db.select({ id: gebaeudeInspections.id }).from(gebaeudeInspections).where(sameTarget);
  if (dup) throw new ValidationError({ dueOn: "Diese Prüfung ist schon geplant" });
  const [r] = await db
    .insert(gebaeudeInspections)
    .values({ typeId: input.typeId, ...target, dueOn: input.dueOn })
    .returning({ id: gebaeudeInspections.id });
  return r!.id;
}

/** Offene Prüfung streichen (Recht `gebaeude.manage`), z. B. falsch geplant. Erledigte bleiben als Nachweis. */
export async function cancelInspection(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  requireManage(viewer);
  const [r] = await db
    .delete(gebaeudeInspections)
    .where(and(eq(gebaeudeInspections.id, id), isNull(gebaeudeInspections.doneOn)))
    .returning({ id: gebaeudeInspections.id });
  if (!r) throw new ValidationError({ inspection: "Nur offene Prüfungen lassen sich streichen" });
  await audit(db, viewer.userId, "gebaeude.inspection.cancel", id);
}

// ---------------------------------------------------------------- Lesen

const roomOfInspection = sql`coalesce(${gebaeudeAssets.roomId}, ${gebaeudeInspections.roomId})`;
const buildingOfInspection = sql<string | null>`coalesce(${gebaeudeInspections.building}, ${assetBuildings.name}, ${rooms.building})`;

/** offene Prüfungen ausgeschalteter Prüfarten bzw. außer Betrieb genommener Anlagen ruhen */
const RESTING_EXCLUDED = sql`(${gebaeudeInspectionTypes.active} and coalesce(${gebaeudeAssets.active}, true))`;

const inspectionColumns = {
  id: gebaeudeInspections.id,
  typeId: gebaeudeInspections.typeId,
  typeName: gebaeudeInspectionTypes.name,
  appliesTo: gebaeudeInspectionTypes.appliesTo,
  warnDays: gebaeudeInspectionTypes.warnDays,
  intervalMonths: gebaeudeInspectionTypes.intervalMonths,
  responsible: gebaeudeInspectionTypes.responsible,
  assetId: gebaeudeInspections.assetId,
  assetName: gebaeudeAssets.name,
  categoryKey: gebaeudeAssetCategories.key,
  inventoryNo: gebaeudeAssets.inventoryNo,
  roomId: sql<string | null>`${roomOfInspection}`,
  building: buildingOfInspection,
  dueOn: gebaeudeInspections.dueOn,
  doneOn: gebaeudeInspections.doneOn,
  result: gebaeudeInspections.result,
  company: gebaeudeInspections.company,
  hasReport: sql<boolean>`${gebaeudeInspections.reportKey} is not null`,
  note: gebaeudeInspections.note,
  ticketId: gebaeudeInspections.ticketId,
  remindedAt: gebaeudeInspections.remindedAt,
};

function inspectionQuery(db: Db) {
  return db
    .select(inspectionColumns)
    .from(gebaeudeInspections)
    .innerJoin(gebaeudeInspectionTypes, eq(gebaeudeInspectionTypes.id, gebaeudeInspections.typeId))
    .leftJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeInspections.assetId))
    .leftJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId))
    .leftJoin(assetBuildings, eq(assetBuildings.id, gebaeudeAssets.buildingId))
    .leftJoin(rooms, sql`${rooms.id} = ${roomOfInspection}`);
}

/** Rein: Gegenstand einer Prüfung – Anlage (mit Inventarnummer), Raum oder Gebäude. */
export function targetLabel(i: { assetName: string | null; inventoryNo: string | null; roomId: string | null; building: string | null; appliesTo: InspectionTarget }): string {
  if (i.assetName) return i.inventoryNo ? `${i.assetName} (${i.inventoryNo})` : i.assetName;
  if (i.appliesTo === "raum" && i.roomId) return `Raum ${i.roomId}`;
  return i.building ?? "ganze Schule";
}

export type InspectionRow = Awaited<ReturnType<typeof listInspections>>[number];

export interface InspectionFilter {
  /** offen (Vorgabe), überfällig, bald fällig, erledigt oder alle */
  state?: "offen" | "ueberfaellig" | "faellig" | "erledigt" | "alle";
  typeId?: string;
  building?: string;
  /** INV-03: nur Prüfungen dieses Inventarguts (Asset-Seite) */
  assetId?: string;
  limit?: number;
}

/** Prüfungen mit Stand (Recht `gebaeude.manage` oder `gebaeude.view_all`). Offene nach Fälligkeit, erledigte neueste zuerst. */
export async function listInspections(db: Db, viewer: PermissionSet, f: InspectionFilter, today: string) {
  requireViewAll(viewer);
  const state = f.state ?? "offen";
  const parts: (SQL | undefined)[] = [
    state === "erledigt" ? isNotNull(gebaeudeInspections.doneOn) : state === "alle" ? undefined : isNull(gebaeudeInspections.doneOn),
    // offene Prüfungen ausgeschalteter Prüfarten bzw. außer Betrieb genommener Anlagen ruhen
    state === "erledigt" ? undefined : sql`(${gebaeudeInspections.doneOn} is not null or ${RESTING_EXCLUDED})`,
    f.typeId ? eq(gebaeudeInspections.typeId, f.typeId) : undefined,
    f.building ? sql`${buildingOfInspection} = ${f.building}` : undefined,
    f.assetId ? eq(gebaeudeInspections.assetId, f.assetId) : undefined,
  ];
  // Stand als SQL-Bedingung vor dem Limit (sonst fehlen bei großen Beständen Einträge, Code-Review Gate 4a N9)
  if (state === "ueberfaellig") parts.push(OVERDUE(today));
  if (state === "faellig") parts.push(DUE_SOON(today));
  const rows = await inspectionQuery(db)
    .where(and(...parts))
    .orderBy(state === "erledigt" ? desc(gebaeudeInspections.doneOn) : asc(gebaeudeInspections.dueOn), asc(gebaeudeInspectionTypes.name))
    .limit(f.limit ?? 1000);
  return rows.map((r) => ({ ...r, state: inspectionState(r, r.warnDays, today), target: targetLabel(r) }));
}

/** überfällig: Termin vor heute */
const OVERDUE = (today: string) => lt(gebaeudeInspections.dueOn, today);
/** bald fällig: ab heute bis heute + Vorwarnzeit der Prüfart (wie inspectionState) */
const DUE_SOON = (today: string) => and(gte(gebaeudeInspections.dueOn, today), sql`${gebaeudeInspections.dueOn} <= ${today}::date + ${gebaeudeInspectionTypes.warnDays}`);

/** Überblick für Widget und Kopf der Prüfungsseite – per SQL gezählt, ohne Obergrenze. */
export async function inspectionSummary(db: Db, viewer: PermissionSet, today: string) {
  requireViewAll(viewer);
  const [r] = await db
    .select({
      open: count(),
      overdue: sql<number>`count(*) filter (where ${OVERDUE(today)})`.mapWith(Number),
      due: sql<number>`count(*) filter (where ${DUE_SOON(today)})`.mapWith(Number),
    })
    .from(gebaeudeInspections)
    .innerJoin(gebaeudeInspectionTypes, eq(gebaeudeInspectionTypes.id, gebaeudeInspections.typeId))
    .leftJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeInspections.assetId))
    .where(and(isNull(gebaeudeInspections.doneOn), RESTING_EXCLUDED));
  return { overdue: r?.overdue ?? 0, due: r?.due ?? 0, open: r?.open ?? 0 };
}

/** Gebäude aus Räumen, Anlagen und Prüfungen (Filter). */
export async function inspectionBuildings(db: Db): Promise<string[]> {
  const res = await db.execute(
    sql`select building as b from rooms where building is not null union select b.name from gebaeude_assets a join buildings b on b.id = a.building_id union select building from gebaeude_inspections where building is not null`,
  );
  return rowsOf<{ b: string }>(res)
    .map((r) => r.b)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "de"));
}

// ---------------------------------------------------------------- Erfassen

export interface RecordInput {
  doneOn: string;
  result: string;
  company: string | null;
  note: string | null;
  /** Protokoll als PDF (leer = keins) */
  report?: Uint8Array | null;
}

/** Rein: welche Meldung entsteht bei einem Mangel? Meldungskategorie nach Inventar-Kategorie, Priorität nach Ergebnis. */
export function defectTicket(i: { typeName: string; target: string; categoryKey: string | null }, result: InspectionResult): { category: TicketCategory; priority: "normal" | "hoch"; title: string } {
  const category = ticketCategoryForAsset(i.categoryKey);
  const what = result === "ausser_betrieb" ? "außer Betrieb" : "Mangel";
  return { category, priority: result === "ausser_betrieb" ? "hoch" : "normal", title: `Prüfung ${i.typeName}: ${what} – ${i.target}`.slice(0, 120) };
}

/**
 * Prüfung erfassen (Recht `gebaeude.manage`): Datum, Ergebnis, Firma, optional Protokoll-PDF. Bei Mangel bzw. „außer
 * Betrieb“ entsteht eine Meldung; danach plant SchulOS die nächste Prüfung (Prüfdatum + Intervall).
 */
export async function recordInspection(
  db: Db,
  storage: FileStorage,
  viewer: PermissionSet,
  id: string,
  input: RecordInput,
  opts: { today: string; now?: Date },
): Promise<{ ticketId: string | null; nextId: string | null }> {
  requireManage(viewer);
  const [row] = await inspectionQuery(db).where(eq(gebaeudeInspections.id, id));
  if (!row) throw new ValidationError({ inspection: "Prüfung gibt es nicht" });
  if (row.doneOn) throw new ValidationError({ inspection: "Prüfung ist schon erfasst" });
  const fe: Record<string, string> = {};
  const company = input.company?.trim() || null;
  const note = input.note?.trim() || null;
  if (!YMD.test(input.doneOn)) fe.doneOn = "Prüfdatum angeben";
  else if (input.doneOn > opts.today) fe.doneOn = "Prüfdatum liegt in der Zukunft";
  if (!(INSPECTION_RESULTS as readonly string[]).includes(input.result)) fe.result = "Ergebnis wählen";
  if (company && company.length > 120) fe.company = "höchstens 120 Zeichen";
  if (note && note.length > 2000) fe.note = "höchstens 2000 Zeichen";
  const report = input.report && input.report.length > 0 ? input.report : null;
  if (report && report.length > MAX_REPORT_MB * 1024 * 1024) fe.report = `Protokoll zu groß (höchstens ${MAX_REPORT_MB} MB)`;
  else if (report && !isPdf(report)) fe.report = "Protokoll nur als PDF";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const result = input.result as InspectionResult;

  let reportKey: string | null = null;
  if (report) {
    await scanUpload(report, "Prüfprotokoll", "report"); // P4-72
    reportKey = newStorageKey();
    await storage.put(reportKey, report);
  }
  // Erfassen atomar: nur wer die offene Prüfung als Erste:r abschließt, legt Meldung und Folgeprüfung an (Code-Review
  // Gate 4a N2) – ein doppeltes Absenden scheitert hier, ein ungenutztes Protokoll räumt der Aufräumlauf weg.
  const [claimed] = await db
    .update(gebaeudeInspections)
    .set({ doneOn: input.doneOn, result, company, note, reportKey, reportSize: report?.length ?? null })
    .where(and(eq(gebaeudeInspections.id, id), isNull(gebaeudeInspections.doneOn)))
    .returning({ assetId: gebaeudeInspections.assetId, roomId: gebaeudeInspections.roomId, building: gebaeudeInspections.building });
  if (!claimed) throw new ValidationError({ inspection: "Prüfung ist schon erfasst" });

  let ticketId: string | null = null;
  if (result !== "ok") {
    const t = defectTicket({ typeName: row.typeName, target: targetLabel(row), categoryKey: row.categoryKey }, result);
    const created = await createTicket(
      db,
      storage,
      viewer,
      {
        ...t,
        roomId: row.roomId,
        assetId: claimed.assetId,
        location: row.roomId ? null : (row.building ?? targetLabel(row)).slice(0, 120),
        description: [`Bei der Prüfung am ${input.doneOn} festgestellt${company ? ` (${company})` : ""}.`, note].filter(Boolean).join("\n\n"),
        photos: [],
      },
      { now: opts.now, rateLimit: false },
    );
    ticketId = created.id;
    await db.update(gebaeudeInspections).set({ ticketId }).where(eq(gebaeudeInspections.id, id));
  }
  await audit(db, viewer.userId, "gebaeude.inspection.record", id, { type: row.typeName, result, report: Boolean(report) });

  // nächste Prüfung: gleiche Art, gleicher Gegenstand – solange Art eingeschaltet und Anlage in Betrieb
  const [type] = await db.select().from(gebaeudeInspectionTypes).where(eq(gebaeudeInspectionTypes.id, row.typeId));
  const [asset] = claimed.assetId ? await db.select({ active: gebaeudeAssets.active }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, claimed.assetId)) : [{ active: true }];
  let nextId: string | null = null;
  if (type?.active && asset?.active) {
    const [next] = await db
      .insert(gebaeudeInspections)
      .values({ typeId: row.typeId, ...claimed, dueOn: addMonths(input.doneOn, type.intervalMonths) })
      .returning({ id: gebaeudeInspections.id });
    nextId = next!.id;
  }
  return { ticketId, nextId };
}

/** Protokoll-PDF für die Auslieferung – nur mit `gebaeude.manage`/`gebaeude.view_all`. */
export async function reportFor(db: Db, viewer: PermissionSet, id: string) {
  if (!canViewAll(viewer)) return null;
  const [r] = await db
    .select({ key: gebaeudeInspections.reportKey, size: gebaeudeInspections.reportSize, doneOn: gebaeudeInspections.doneOn })
    .from(gebaeudeInspections)
    .where(eq(gebaeudeInspections.id, id));
  return r?.key ? { key: r.key, size: r.size, doneOn: r.doneOn } : null;
}

// ---------------------------------------------------------------- Fristen-Job „gebaeude-fristen“

export interface ReminderMail {
  config: MailConfig | null;
  sender?: Sender;
  server?: string;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
export const formatDay = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

/** Rein: Alarm-Mail zu überfälligen Prüfungen – nur Prüfart, Gegenstand, Ort und Termin, keine Personen. */
export function overdueMessage(server: string, to: string[], items: { typeName: string; target: string; building: string | null; dueOn: string }[]): MailMessage {
  const lines = items.slice(0, 50).map((i) => `- ${i.typeName}: ${i.target}${i.building ? ` (${i.building})` : ""}, fällig seit ${formatDay(i.dueOn)}`);
  return {
    to,
    subject: `[${server}] ${items.length === 1 ? "1 Prüfung überfällig" : `${items.length} Prüfungen überfällig`}`,
    text: [
      `In ${server} sind wiederkehrende Prüfungen überfällig:`,
      "",
      ...lines,
      ...(items.length > 50 ? [`… und ${items.length - 50} weitere`] : []),
      "",
      "Details und Erfassen in SchulOS unter Gebäude & Technik → Prüfungen.",
    ].join("\n"),
  };
}

/**
 * Nächtlicher Lauf: „bald fällig“ (in der Vorwarnzeit der Prüfart) → Gong an alle mit `gebaeude.manage`, je Prüfung
 * höchstens einmal je Woche; „überfällig“ → täglich Gong und Alarm-Mail (nur mit SMTP). Ein Gong fasst alles zusammen.
 */
export async function runInspectionReminders(db: Db, opts: { now?: Date; mail?: ReminderMail } = {}) {
  const now = opts.now ?? new Date();
  const today = toBerlinDate(now);
  // erst planen: gestrichene oder fehlende Prüfungen von Anlagen kommen so spätestens nachts zurück (Code-Review Gate 4a N3)
  await planDue(db, today);
  const rows = await inspectionQuery(db).where(
    and(isNull(gebaeudeInspections.doneOn), eq(gebaeudeInspectionTypes.active, true), sql`coalesce(${gebaeudeAssets.active}, true)`),
  );
  const items = rows.map((r) => ({ ...r, state: inspectionState(r, r.warnDays, today), target: targetLabel(r) })).filter((r) => reminderDue(r.state, r.remindedAt, now));
  const overdue = items.filter((i) => i.state === "ueberfaellig");
  const due = items.filter((i) => i.state === "faellig");
  if (!items.length) return { overdue: 0, due: 0, notified: 0, mailed: false, mailError: null as string | null };
  const recipients = await usersWithPermission(db, "gebaeude.manage");
  const parts = [overdue.length ? `${overdue.length} überfällig` : null, due.length ? `${due.length} bald fällig` : null].filter(Boolean).join(", ");
  const sample = [...overdue, ...due]
    .slice(0, 3)
    .map((i) => `${i.typeName}: ${i.target} (${formatDay(i.dueOn)})`)
    .join(" · ");
  const notified = await notify(db, recipients, { moduleId: MODULE, title: `Prüfungen: ${parts}`, body: sample, href: overdue.length ? "/gebaeude/pruefungen?stand=ueberfaellig" : "/gebaeude/pruefungen?stand=faellig" });
  await db.update(gebaeudeInspections).set({ remindedAt: now }).where(inArray(gebaeudeInspections.id, items.map((i) => i.id)));
  let mailed = false;
  let mailError: string | null = null;
  if (overdue.length && opts.mail?.config) {
    const cfg = opts.mail.config;
    try {
      await (opts.mail.sender ?? smtpSender(cfg))(overdueMessage(opts.mail.server ?? "SchulOS", cfg.to, overdue));
      mailed = true;
    } catch (err) {
      // Gong ist raus; der Fehler wird gemeldet (Job rot bzw. Hinweis beim manuellen Lauf) statt die Erinnerung abzubrechen
      mailError = err instanceof Error ? err.message : String(err);
      console.error("[gebaeude] Alarm-Mail zu überfälligen Prüfungen fehlgeschlagen:", err);
    }
  }
  return { overdue: overdue.length, due: due.length, notified, mailed, mailError };
}

// ---------------------------------------------------------------- Prüfliste, CSV, Statistik (P4-18)

export interface ChecklistRow {
  key: string;
  typeId: string;
  typeName: string;
  source: string;
  responsible: InspectionResponsible;
  intervalMonths: number;
  target: string;
  roomId: string | null;
  building: string | null;
  last: { doneOn: string; result: InspectionResult | null; company: string | null; ticketId: string | null } | null;
  next: { dueOn: string; state: InspectionState } | null;
}

/** Prüfliste je Gegenstand: letzte Prüfung (Datum, Ergebnis, Firma) und nächste Fälligkeit – Nachweis für den Schulträger. */
export async function checklist(db: Db, viewer: PermissionSet, f: { building?: string; typeId?: string }, today: string): Promise<ChecklistRow[]> {
  requireViewAll(viewer);
  const rows = await inspectionQuery(db)
    .where(and(f.typeId ? eq(gebaeudeInspections.typeId, f.typeId) : undefined, f.building ? sql`${buildingOfInspection} = ${f.building}` : undefined))
    .orderBy(asc(gebaeudeInspectionTypes.name), desc(gebaeudeInspections.dueOn));
  const types = new Map((await db.select({ id: gebaeudeInspectionTypes.id, source: gebaeudeInspectionTypes.source, active: gebaeudeInspectionTypes.active }).from(gebaeudeInspectionTypes)).map((t) => [t.id, t]));
  const map = new Map<string, ChecklistRow>();
  for (const r of rows) {
    const key = `${r.typeId}|${r.assetId ?? ""}|${r.assetId ? "" : (r.roomId ?? "")}|${r.assetId ? "" : (r.building ?? "")}`;
    const target = targetLabel(r);
    const entry =
      map.get(key) ??
      ({
        key,
        typeId: r.typeId,
        typeName: r.typeName,
        source: types.get(r.typeId)?.source ?? "",
        responsible: r.responsible,
        intervalMonths: r.intervalMonths,
        target,
        roomId: r.roomId,
        building: r.building,
        last: null,
        next: null,
      } satisfies ChecklistRow);
    if (r.doneOn) {
      if (!entry.last || entry.last.doneOn < r.doneOn) entry.last = { doneOn: r.doneOn, result: r.result, company: r.company, ticketId: r.ticketId };
    } else if (types.get(r.typeId)?.active !== false && (!entry.next || r.dueOn < entry.next.dueOn)) {
      entry.next = { dueOn: r.dueOn, state: inspectionState(r, r.warnDays, today) };
    }
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => a.typeName.localeCompare(b.typeName, "de") || a.target.localeCompare(b.target, "de", { numeric: true }));
}

/** CSV der Prüfungen – ohne Personennamen und ohne Freitext (Bemerkungen können Namen enthalten). */
export async function inspectionsCsv(db: Db, viewer: PermissionSet, today: string): Promise<string> {
  const rows = await listInspections(db, viewer, { state: "alle", limit: 50_000 }, today);
  rows.sort((a, b) => a.typeName.localeCompare(b.typeName, "de") || a.target.localeCompare(b.target, "de") || a.dueOn.localeCompare(b.dueOn));
  const tickets = new Map(
    (await db.select({ id: gebaeudeTickets.id, year: gebaeudeTickets.year, seq: gebaeudeTickets.seq }).from(gebaeudeTickets)).map((t) => [t.id, ticketNumber(t.year, t.seq)]),
  );
  return toCsv([
    ["Prüfart", "Gegenstand", "Inventarnummer", "Raum", "Gebäude", "fällig am", "geprüft am", "Ergebnis", "Firma", "Stand", "Meldung"],
    ...rows.map((r) => [
      r.typeName,
      r.assetName ?? r.target,
      r.inventoryNo,
      r.roomId,
      r.building,
      r.dueOn,
      r.doneOn,
      r.result ? RESULT_LABELS[r.result] : r.doneOn ? "übernommen" : "",
      r.company,
      INSPECTION_STATE_LABELS[r.state],
      r.ticketId ? (tickets.get(r.ticketId) ?? "") : "",
    ]),
  ]);
}

/** CSV der Meldungen – ohne Personennamen und ohne Beschreibung (Freitext). */
export async function ticketsCsv(db: Db, viewer: PermissionSet): Promise<string> {
  requireViewAll(viewer);
  const rows = await db
    .select({
      year: gebaeudeTickets.year,
      seq: gebaeudeTickets.seq,
      category: gebaeudeTickets.category,
      priority: gebaeudeTickets.priority,
      status: gebaeudeTickets.status,
      roomId: gebaeudeTickets.roomId,
      building: rooms.building,
      location: gebaeudeTickets.location,
      title: gebaeudeTickets.title,
      createdAt: gebaeudeTickets.createdAt,
      closedAt: gebaeudeTickets.closedAt,
    })
    .from(gebaeudeTickets)
    .leftJoin(rooms, eq(rooms.id, gebaeudeTickets.roomId))
    .orderBy(asc(gebaeudeTickets.year), asc(gebaeudeTickets.seq));
  return toCsv([
    ["Nummer", "Kategorie", "Priorität", "Status", "Ort", "Gebäude", "Titel", "gemeldet am", "abgeschlossen am"],
    ...rows.map((r) => [
      ticketNumber(r.year, r.seq),
      CATEGORY_LABELS[r.category],
      PRIORITY_LABELS[r.priority],
      STATUS_LABELS[r.status],
      placeLabel(r),
      r.building,
      r.title,
      toBerlinDate(r.createdAt),
      r.closedAt ? toBerlinDate(r.closedAt) : "",
    ]),
  ]);
}

/** Rein: die letzten `n` Monate bis einschließlich des Monats von `today` („2026-10“, absteigend). */
export function lastMonths(today: string, n: number): string[] {
  const first = `${today.slice(0, 7)}-01`;
  return Array.from({ length: n }, (_, i) => addMonths(first, -i).slice(0, 7));
}

/** Meldungen je Monat und Kategorie (nach Meldedatum) plus Durchschnitt bis zum Abschluss – ohne Personenbezug. */
export async function ticketStats(db: Db, viewer: PermissionSet, now: Date, months = 12) {
  requireViewAll(viewer);
  const today = toBerlinDate(now);
  const list = lastMonths(today, months);
  const since = fromBerlinLocal(`${list[list.length - 1]}-01`);
  const rows = await db
    .select({ category: gebaeudeTickets.category, createdAt: gebaeudeTickets.createdAt, closedAt: gebaeudeTickets.closedAt })
    .from(gebaeudeTickets)
    .where(gte(gebaeudeTickets.createdAt, since));
  const byMonth = new Map(list.map((m) => [m, Object.fromEntries(TICKET_CATEGORIES.map((c) => [c, 0])) as Record<TicketCategory, number>]));
  const byCategory = Object.fromEntries(TICKET_CATEGORIES.map((c) => [c, { count: 0, closed: 0, days: 0 }])) as Record<TicketCategory, { count: number; closed: number; days: number }>;
  for (const r of rows) {
    const m = byMonth.get(toBerlinDate(r.createdAt).slice(0, 7));
    if (!m) continue;
    m[r.category]++;
    const c = byCategory[r.category];
    c.count++;
    if (r.closedAt) {
      c.closed++;
      c.days += (r.closedAt.getTime() - r.createdAt.getTime()) / 86_400_000;
    }
  }
  return {
    months: list.map((m) => ({ month: m, counts: byMonth.get(m)! })),
    categories: TICKET_CATEGORIES.map((c) => ({ category: c, count: byCategory[c].count, avgDays: byCategory[c].closed ? Math.round((byCategory[c].days / byCategory[c].closed) * 10) / 10 : null })),
    total: rows.length,
  };
}

/** Aktive Räume als Auswahl („Raum 112 · Hauptgebäude“). */
export async function roomOptions(db: Db): Promise<{ value: string; label: string }[]> {
  const list = await db.select({ id: rooms.id, name: rooms.name, building: rooms.building }).from(rooms).where(eq(rooms.active, true));
  return list
    .sort((a, b) => a.id.localeCompare(b.id, "de", { numeric: true }))
    .map((r) => ({ value: r.id, label: [r.id === r.name || r.name === `Raum ${r.id}` ? `Raum ${r.id}` : `${r.id} – ${r.name}`, r.building].filter(Boolean).join(" · ") }));
}
