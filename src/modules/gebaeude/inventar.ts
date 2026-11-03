// INV-01: Inventar-Grundlage – Kategorien (Tabelle statt Enum, Vorlage `kategorien.ts`), Rechte (`gebaeude.inventory`,
// `gebaeude.configure`, verantwortliche Gruppe je Kategorie) und automatische Inventarnummern (Zähler je Präfix). Die Anlagen
// selbst (anlegen, ändern, Liste, CSV) stehen weiter in `pruefungen.ts`, weil sie mit der Prüfplanung verzahnt sind.
// Kein Personenbezug: Kategorien nennen eine Gruppe, Zähler nur Zahlen; wer geändert hat, steht nur im Audit-Log.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { gebaeudeAssetCategories, gebaeudeAssets, gebaeudeInventoryCounters, groups } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, accessBlocked, hasPermission, type PermissionSet } from "@/core/permissions";
import { isStaffRole } from "@/core/roles";
import { ValidationError } from "@/modules/verwaltung/users";
import { ASSET_CATEGORY_TEMPLATE, LIFETIME_MAX, LIFETIME_MIN, PREFIX_RE, categoryKeyFromName } from "./kategorien";
import { INVENTORY_NO_FORMATS, formatInventoryNo, inventoryCounterKey, type InventoryNoFormat } from "./labels";
import { canViewAll } from "./service";
import { INVENTORY_NO_FORMAT } from "./settings";

export const INVENTORY_PERMISSION = "gebaeude.inventory";

// ---------------------------------------------------------------- Rechte

export const canConfigure = (p: PermissionSet) => hasPermission(p, "gebaeude.configure");

/** Inventar pflegen für alle Kategorien: Recht `gebaeude.inventory` (Vorgabe über Gruppen Hausmeisterei/IT) oder `configure`. */
export const canMaintainInventory = (p: PermissionSet) => hasPermission(p, INVENTORY_PERMISSION) || canConfigure(p);

/**
 * Kategorien (IDs), deren Inventar die Person pflegt: `null` = alle (`inventory`/`configure`), sonst die Kategorien, deren
 * verantwortliche Gruppe die Person als Beschäftigte:r angehört (inv-4). Schüler:innen/Eltern nie.
 */
export async function maintainableCategories(db: Db, viewer: PermissionSet): Promise<Set<string> | null> {
  if (canMaintainInventory(viewer)) return null;
  if (accessBlocked(viewer) || !isStaffRole(viewer.role) || viewer.memberOf.size === 0) return new Set();
  const rows = await db
    .select({ id: gebaeudeAssetCategories.id })
    .from(gebaeudeAssetCategories)
    .where(inArray(gebaeudeAssetCategories.responsibleGroupId, [...viewer.memberOf]));
  return new Set(rows.map((r) => r.id));
}

/** Darf die Person das Inventar überhaupt sehen (alles lesen, pflegen oder mindestens eine Kategorie verantworten)? */
export async function canSeeInventory(db: Db, viewer: PermissionSet): Promise<boolean> {
  if (canViewAll(viewer) || canMaintainInventory(viewer)) return true;
  const own = await maintainableCategories(db, viewer);
  return own !== null && own.size > 0;
}

/** Pflegerecht für eine Kategorie erzwingen (Service-Grenze jeder Schreibaktion am Inventar). */
export async function requireMaintain(db: Db, viewer: PermissionSet, categoryId: string): Promise<void> {
  const own = await maintainableCategories(db, viewer);
  if (own !== null && !own.has(categoryId)) throw new ForbiddenError(INVENTORY_PERMISSION);
}

function requireConfigure(p: PermissionSet) {
  if (!canConfigure(p)) throw new ForbiddenError("gebaeude.configure");
}

// ---------------------------------------------------------------- Kategorien

/** Vorlage einspielen (fehlende Schlüssel). Bestehende – auch angepasste – bleiben unverändert. */
export async function ensureCategories(db: Db): Promise<void> {
  await db
    .insert(gebaeudeAssetCategories)
    .values(ASSET_CATEGORY_TEMPLATE.map((t) => ({ key: t.key, name: t.name, prefix: t.prefix, inspectionRequired: t.inspectionRequired, sortOrder: t.sort, lifetimeYears: t.lifetimeYears })))
    .onConflictDoNothing({ target: gebaeudeAssetCategories.key });
}

export type AssetCategoryRow = typeof gebaeudeAssetCategories.$inferSelect & { responsibleGroupName: string | null; assetCount: number };

/** Kategorien in Reihenfolge (Vorlage zuerst sicherstellen). `activeOnly` für Auswahlfelder. */
export async function listCategories(db: Db, opts: { activeOnly?: boolean } = {}): Promise<AssetCategoryRow[]> {
  await ensureCategories(db);
  const rows = await db
    .select({
      id: gebaeudeAssetCategories.id,
      key: gebaeudeAssetCategories.key,
      name: gebaeudeAssetCategories.name,
      prefix: gebaeudeAssetCategories.prefix,
      inspectionRequired: gebaeudeAssetCategories.inspectionRequired,
      responsibleGroupId: gebaeudeAssetCategories.responsibleGroupId,
      sortOrder: gebaeudeAssetCategories.sortOrder,
      active: gebaeudeAssetCategories.active,
      lifetimeYears: gebaeudeAssetCategories.lifetimeYears,
      createdAt: gebaeudeAssetCategories.createdAt,
      responsibleGroupName: groups.name,
      assetCount: sql<number>`(select count(*)::int from gebaeude_assets a where a.category_id = ${gebaeudeAssetCategories.id} and a.retired_on is null)`,
    })
    .from(gebaeudeAssetCategories)
    .leftJoin(groups, eq(groups.id, gebaeudeAssetCategories.responsibleGroupId))
    .where(opts.activeOnly ? eq(gebaeudeAssetCategories.active, true) : undefined)
    .orderBy(asc(gebaeudeAssetCategories.sortOrder), asc(gebaeudeAssetCategories.createdAt));
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "de"));
}

/** Kategorie je ID (ohne Rechteprüfung – für Anzeige und Validierung). */
export async function categoryById(db: Db, id: string) {
  const [c] = await db.select().from(gebaeudeAssetCategories).where(eq(gebaeudeAssetCategories.id, id));
  return c ?? null;
}

export interface CategoryInput {
  name: string;
  prefix: string;
  inspectionRequired: boolean;
  responsibleGroupId: string | null;
  sortOrder: number;
  active: boolean;
  /** INV-10: Nutzungsdauer in Jahren (Richtwert für den Ersatzbedarf); leer/null = kein Richtwert. Fehlt das Feld, bleibt der Wert. */
  lifetimeYears?: string | number | null;
}

async function validateCategory(db: Db, input: CategoryInput, selfId?: string) {
  const fe: Record<string, string> = {};
  const name = input.name.trim();
  const prefix = input.prefix.trim().toUpperCase();
  const responsibleGroupId = input.responsibleGroupId?.trim() || null;
  if (name.length < 2 || name.length > 80) fe.name = "Name mit 2 bis 80 Zeichen";
  if (!PREFIX_RE.test(prefix)) fe.prefix = "Präfix: 1 bis 6 Großbuchstaben oder Ziffern";
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 100000) fe.sortOrder = "Reihenfolge 0 bis 100000";
  const rawLifetime = input.lifetimeYears === undefined ? undefined : String(input.lifetimeYears ?? "").trim();
  const lifetimeYears = rawLifetime === undefined ? undefined : rawLifetime === "" ? null : Number(rawLifetime);
  if (typeof lifetimeYears === "number" && (!Number.isInteger(lifetimeYears) || lifetimeYears < LIFETIME_MIN || lifetimeYears > LIFETIME_MAX))
    fe.lifetimeYears = `Nutzungsdauer ${LIFETIME_MIN} bis ${LIFETIME_MAX} Jahre (leer = kein Richtwert)`;
  if (responsibleGroupId) {
    const [g] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, responsibleGroupId));
    if (!g) fe.responsibleGroupId = "Gruppe gibt es nicht";
  }
  if (!fe.name) {
    const [dup] = await db
      .select({ id: gebaeudeAssetCategories.id })
      .from(gebaeudeAssetCategories)
      .where(sql`lower(${gebaeudeAssetCategories.name}) = ${name.toLowerCase()}`);
    if (dup && dup.id !== selfId) fe.name = "Diese Kategorie gibt es schon";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    name,
    prefix,
    inspectionRequired: input.inspectionRequired,
    responsibleGroupId,
    sortOrder: input.sortOrder,
    active: input.active,
    ...(lifetimeYears === undefined ? {} : { lifetimeYears }),
  };
}

/** Eigene Kategorie anlegen (Recht `gebaeude.configure`); Schlüssel aus dem Namen, bei Dopplung mit Zähler. */
export async function createCategory(db: Db, viewer: PermissionSet, input: CategoryInput): Promise<string> {
  requireConfigure(viewer);
  const row = await validateCategory(db, input);
  const base = categoryKeyFromName(row.name) || "kategorie";
  const taken = new Set((await db.select({ key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories).where(sql`${gebaeudeAssetCategories.key} like ${`${base}%`}`)).map((r) => r.key));
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  const [r] = await db.insert(gebaeudeAssetCategories).values({ key, ...row }).returning({ id: gebaeudeAssetCategories.id });
  await audit(db, viewer.userId, "gebaeude.asset_category.create", r!.id, { name: row.name, prefix: row.prefix });
  return r!.id;
}

/** Kategorie anpassen (Name, Präfix, Prüfpflicht, Gruppe, Reihenfolge, aktiv, Nutzungsdauer – INV-10) – Recht `gebaeude.configure`. */
export async function updateCategory(db: Db, viewer: PermissionSet, id: string, input: CategoryInput): Promise<void> {
  requireConfigure(viewer);
  const row = await validateCategory(db, input, id);
  const [r] = await db.update(gebaeudeAssetCategories).set(row).where(eq(gebaeudeAssetCategories.id, id)).returning({ id: gebaeudeAssetCategories.id });
  if (!r) throw new ValidationError({ name: "Kategorie gibt es nicht" });
  await audit(db, viewer.userId, "gebaeude.asset_category.update", id, {
    name: row.name,
    prefix: row.prefix,
    active: row.active,
    inspectionRequired: row.inspectionRequired,
    ...(row.lifetimeYears === undefined ? {} : { lifetimeYears: row.lifetimeYears }),
  });
}

/** Kategorie löschen – nur ohne Anlagen und ohne Prüfarten-Bezug (sonst ausschalten); Vorlagen-Schlüssel kämen beim nächsten Aufruf wieder. */
export async function deleteCategory(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  requireConfigure(viewer);
  const [c] = await db.select().from(gebaeudeAssetCategories).where(eq(gebaeudeAssetCategories.id, id));
  if (!c) throw new ValidationError({ name: "Kategorie gibt es nicht" });
  if (ASSET_CATEGORY_TEMPLATE.some((t) => t.key === c.key)) throw new ValidationError({ name: "Kategorien der Vorlage lassen sich nur ausschalten" });
  const [used] = await db.select({ id: gebaeudeAssets.id }).from(gebaeudeAssets).where(eq(gebaeudeAssets.categoryId, id)).limit(1);
  if (used) throw new ValidationError({ name: "Es gibt noch Inventar in dieser Kategorie – bitte ausschalten" });
  await db.delete(gebaeudeAssetCategories).where(eq(gebaeudeAssetCategories.id, id));
  await audit(db, viewer.userId, "gebaeude.asset_category.delete", id, { name: c.name });
}

// ---------------------------------------------------------------- Inventarnummern

/** Format aus der Moduleinstellung. */
export async function inventoryNoFormat(db: Db): Promise<InventoryNoFormat> {
  const v = await readModuleSetting(db, INVENTORY_NO_FORMAT);
  return (INVENTORY_NO_FORMATS as readonly string[]).includes(v) ? (v as InventoryNoFormat) : "prefix-4";
}

/**
 * Nächste freie Inventarnummer für ein Präfix: Zähler atomar erhöhen (`insert … on conflict do update … returning`), schon
 * von Hand oder per Import vergebene Nummern werden übersprungen. Innerhalb einer Transaktion aufrufen, damit Nummer und
 * Anlage zusammen gespeichert werden.
 */
export async function nextInventoryNo(db: Db, prefix: string, format: InventoryNoFormat, today: string): Promise<string> {
  const year = Number(today.slice(0, 4));
  const key = inventoryCounterKey(format, prefix, year);
  for (let i = 0; i < 10_000; i++) {
    const [row] = await db
      .insert(gebaeudeInventoryCounters)
      .values({ key, next: 2 })
      .onConflictDoUpdate({ target: gebaeudeInventoryCounters.key, set: { next: sql`${gebaeudeInventoryCounters.next} + 1` } })
      .returning({ next: gebaeudeInventoryCounters.next });
    const no = formatInventoryNo(format, prefix, row!.next - 1, year);
    const [taken] = await db.select({ id: gebaeudeAssets.id }).from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, no));
    if (!taken) return no;
  }
  throw new Error("Inventarnummer: kein freier Zähler");
}

/** Prüfpflichtige Kategorien ohne eingeschaltete Prüfart – Hinweis für die Einrichtung. */
export async function categoriesWithoutInspectionType(db: Db): Promise<string[]> {
  const rows = await db.execute(
    sql`select c.name from gebaeude_asset_categories c where c.inspection_required and c.active and not exists (select 1 from gebaeude_inspection_types t where t.category_id = c.id and t.active) order by c.sort_order`,
  );
  return rowsOf<{ name: string }>(rows).map((r) => r.name);
}

/** Anzahl aktiver Anlagen je Kategorie (Liste, Karte „Inventar“). */
export async function assetCountByCategory(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ categoryId: gebaeudeAssets.categoryId, n: sql<number>`count(*)::int` })
    .from(gebaeudeAssets)
    .where(and(eq(gebaeudeAssets.active, true), isNull(gebaeudeAssets.retiredOn)))
    .groupBy(gebaeudeAssets.categoryId);
  return new Map(rows.map((r) => [r.categoryId, r.n]));
}
