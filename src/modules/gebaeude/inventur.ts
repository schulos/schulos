// INV-04 (docs/INVENTAR.md, Stufe 3): Inventur je Raum – Soll (Inventar des Raums beim Start) gegen Ist. Erfasst wird über das
// Etikett (Kamera-App öffnet `/i/<code>` → Geräteseite → Knopf „gefunden“), über die Scan-/Eingabezeile der Inventurseite (In-App-Scan,
// Handscanner, abgetippte Nummer) oder per Knopf in der Liste. Ein gescanntes Gerät aus einem anderen Raum wird „falscher Raum“ und
// lässt sich per Knopf in den Inventurraum übernehmen. Beim Abschluss wird alles Offene „fehlt“; das Inventar selbst ändert die
// Inventur nicht von allein (konservativ: Ausmustern/Umzug entscheiden die Pflegenden).
// Rechte: durchführen nur mit `gebaeude.inventory`/`configure` (alle Kategorien eines Raums), lesen zusätzlich mit `view_all`.
// Kein Personenbezug in den Tabellen: wer gestartet, erfasst oder abgeschlossen hat, steht nur im Audit-Log.
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import { toCsv } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { gebaeudeAssetCategories, gebaeudeAssets, gebaeudeInventories, gebaeudeInventoryItems, rooms } from "@/core/db/schema";
import { resolveLabelCode } from "@/core/etiketten/service";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { moveAsset } from "./asset-seite";
import { INVENTORY_PERMISSION, canConfigure, canMaintainInventory } from "./inventar";
import { INVENTORY_ITEM_STATE_LABELS, INVENTORY_METHOD_LABELS, parseScanInput, type InventoryItemState, type InventoryMethod } from "./labels";
import { canViewAll } from "./service";

/** Höchstmenge eines Sammelpostens beim Zählen. */
export const INVENTORY_MAX_COUNT = 100_000;

// ---------------------------------------------------------------- Rechte

/** Inventur durchführen: Recht `gebaeude.inventory` bzw. `configure` – eine Raum-Inventur umfasst alle Kategorien. */
export const canRunInventory = (p: PermissionSet) => canMaintainInventory(p);
/** Inventuren und Protokolle lesen: durchführen dürfen oder `view_all`. */
export const canReadInventories = (p: PermissionSet) => canRunInventory(p) || canViewAll(p);

function requireRun(p: PermissionSet) {
  if (!canRunInventory(p)) throw new ForbiddenError(INVENTORY_PERMISSION);
}
function requireRead(p: PermissionSet) {
  if (!canReadInventories(p)) throw new ForbiddenError(INVENTORY_PERMISSION);
}

// ---------------------------------------------------------------- rein

export interface InventorySummary {
  /** Soll-Posten (Inventar des Raums beim Start) */
  expected: number;
  /** davon erledigt (nicht mehr offen) */
  done: number;
  found: number;
  missing: number;
  open: number;
  /** Geräte aus anderen Räumen (falscher Raum, noch nicht übernommen) */
  wrongRoom: number;
  /** übernommen in diesen Raum */
  moved: number;
  /** Sammelposten mit weniger gezählt als Soll */
  short: number;
}

/** Rein: Zählung einer Inventur. */
export function summarizeInventory(items: readonly { expected: boolean; state: InventoryItemState; quantity: number; counted: number | null }[]): InventorySummary {
  const s: InventorySummary = { expected: 0, done: 0, found: 0, missing: 0, open: 0, wrongRoom: 0, moved: 0, short: 0 };
  for (const i of items) {
    if (i.expected) {
      s.expected++;
      if (i.state !== "offen") s.done++;
    }
    if (i.state === "gefunden") s.found++;
    else if (i.state === "fehlt") s.missing++;
    else if (i.state === "offen") s.open++;
    else if (i.state === "falscher_raum") s.wrongRoom++;
    else if (i.state === "umgezogen") s.moved++;
    if (i.state === "gefunden" && i.counted !== null && i.counted < i.quantity) s.short++;
  }
  return s;
}

const STATE_ORDER: Record<InventoryItemState, number> = { offen: 0, falscher_raum: 1, fehlt: 2, gefunden: 3, umgezogen: 4 };

/** Rein: Reihenfolge der Liste – offen zuerst, dann falscher Raum, fehlt, gefunden; innerhalb nach Inventarnummer. */
export function sortInventoryItems<T extends { state: InventoryItemState; inventoryNo: string | null; name: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.inventoryNo ?? "~").localeCompare(b.inventoryNo ?? "~", "de", { numeric: true }) || a.name.localeCompare(b.name, "de"),
  );
}

/** Rein: Raum als Text wie in den Auswahllisten („Raum 112 · Hauptgebäude“ bzw. „IF1 – Informatik 1 · Neubau“). */
export function roomLabelOf(r: { id: string; name: string; building: string | null }): string {
  return [r.id === r.name || r.name === `Raum ${r.id}` ? `Raum ${r.id}` : `${r.id} – ${r.name}`, r.building].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- Starten, lesen

export interface InventoryRow {
  id: string;
  roomId: string | null;
  roomLabel: string;
  startedAt: Date;
  closedAt: Date | null;
  summary: InventorySummary;
}

/**
 * Inventur eines Raums starten: Soll = Inventar in Betrieb mit diesem Raum (Nummer, Bezeichnung, Kategorie, Menge mitgeschrieben).
 * Je Raum nur eine laufende – läuft schon eine, kommt deren ID zurück (`existing`).
 */
export async function startInventory(db: Db, viewer: PermissionSet, rawRoomId: string): Promise<{ id: string; existing: boolean }> {
  requireRun(viewer);
  const roomId = rawRoomId.trim();
  if (!roomId) throw new ValidationError({ roomId: "Raum wählen" });
  const [room] = await db.select({ id: rooms.id, name: rooms.name, building: rooms.building }).from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new ValidationError({ roomId: "Raum gibt es nicht" });
  const result = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gebaeude:inventur:${room.id}`}))`);
    const [open] = await tx
      .select({ id: gebaeudeInventories.id })
      .from(gebaeudeInventories)
      .where(and(eq(gebaeudeInventories.roomId, room.id), isNull(gebaeudeInventories.closedAt)));
    if (open) return { id: open.id, existing: true, expected: 0 };
    const [inv] = await tx.insert(gebaeudeInventories).values({ roomId: room.id, roomLabel: roomLabelOf(room) }).returning({ id: gebaeudeInventories.id });
    const assets = await tx
      .select({ id: gebaeudeAssets.id, inventoryNo: gebaeudeAssets.inventoryNo, name: gebaeudeAssets.name, quantity: gebaeudeAssets.quantity, categoryName: gebaeudeAssetCategories.name })
      .from(gebaeudeAssets)
      .innerJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId))
      .where(and(eq(gebaeudeAssets.roomId, room.id), eq(gebaeudeAssets.active, true), isNull(gebaeudeAssets.retiredOn)));
    if (assets.length > 0)
      await tx.insert(gebaeudeInventoryItems).values(
        assets.map((a) => ({ inventoryId: inv!.id, assetId: a.id, inventoryNo: a.inventoryNo, name: a.name, categoryName: a.categoryName, expected: true, quantity: a.quantity })),
      );
    return { id: inv!.id, existing: false, expected: assets.length };
  });
  if (!result.existing) await audit(db, viewer.userId, "gebaeude.inventory.start", result.id, { room: room.id, expected: result.expected });
  return { id: result.id, existing: result.existing };
}

async function itemsOf(db: Db, inventoryIds: readonly string[]) {
  if (inventoryIds.length === 0) return [];
  return db.select().from(gebaeudeInventoryItems).where(inArray(gebaeudeInventoryItems.inventoryId, [...inventoryIds]));
}

/** Inventuren (laufende zuerst, dann abgeschlossene, neueste zuerst) mit Zählung. */
export async function listInventories(db: Db, viewer: PermissionSet, opts: { limit?: number; openOnly?: boolean } = {}): Promise<InventoryRow[]> {
  requireRead(viewer);
  const list = await db
    .select()
    .from(gebaeudeInventories)
    .where(opts.openOnly ? isNull(gebaeudeInventories.closedAt) : undefined)
    .orderBy(sql`${gebaeudeInventories.closedAt} is null desc`, desc(gebaeudeInventories.startedAt), asc(gebaeudeInventories.id))
    .limit(opts.limit ?? 200);
  const items = await itemsOf(
    db,
    list.map((i) => i.id),
  );
  return list.map((i) => ({ id: i.id, roomId: i.roomId, roomLabel: i.roomLabel, startedAt: i.startedAt, closedAt: i.closedAt, summary: summarizeInventory(items.filter((x) => x.inventoryId === i.id)) }));
}

export type InventoryItemRow = typeof gebaeudeInventoryItems.$inferSelect;

/** Eine Inventur mit Posten (sortiert) und Zählung; `null` = gibt es nicht. */
export async function getInventory(db: Db, viewer: PermissionSet, id: string): Promise<(InventoryRow & { items: InventoryItemRow[] }) | null> {
  requireRead(viewer);
  const [inv] = await db.select().from(gebaeudeInventories).where(eq(gebaeudeInventories.id, id));
  if (!inv) return null;
  const items = await itemsOf(db, [id]);
  return { id: inv.id, roomId: inv.roomId, roomLabel: inv.roomLabel, startedAt: inv.startedAt, closedAt: inv.closedAt, summary: summarizeInventory(items), items: sortInventoryItems(items) };
}

/** Laufende Inventur sperren und zurückgeben (Schreibaktionen); abgeschlossen → Fehler. */
async function lockOpen(tx: Db, inventoryId: string) {
  const [inv] = await tx.select().from(gebaeudeInventories).where(eq(gebaeudeInventories.id, inventoryId)).for("update");
  if (!inv) throw new ValidationError({ inventory: "Inventur gibt es nicht" });
  if (inv.closedAt) throw new ValidationError({ inventory: "Die Inventur ist abgeschlossen" });
  return inv;
}

// ---------------------------------------------------------------- Erfassen

export interface ScanResult {
  itemId: string;
  assetId: string;
  name: string;
  inventoryNo: string | null;
  state: InventoryItemState;
  /** Raum laut Inventar, wenn das Gerät woanders hingehört */
  homeRoomId: string | null;
  /** war schon erfasst (kein neuer Eintrag) */
  already: boolean;
  roomLabel: string;
}

/**
 * Gerät in einer laufenden Inventur als gesehen erfassen (Etikett, Scan, Eingabe). Soll-Posten → „gefunden“ (Sammelposten: Soll-Menge
 * als gezählt, solange nicht von Hand gezählt). Gerät nicht im Soll: gehört es laut Inventar in diesen Raum (nach dem Start
 * umgezogen) → „gefunden“, sonst „falscher Raum“ mit dem Raum laut Inventar. Ausgemustertes Inventar wird nicht erfasst.
 */
export async function scanAsset(db: Db, viewer: PermissionSet, inventoryId: string, assetId: string, method: InventoryMethod): Promise<ScanResult> {
  requireRun(viewer);
  const res = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const inv = await lockOpen(tx, inventoryId);
    const [a] = await tx
      .select({ id: gebaeudeAssets.id, name: gebaeudeAssets.name, inventoryNo: gebaeudeAssets.inventoryNo, roomId: gebaeudeAssets.roomId, quantity: gebaeudeAssets.quantity, active: gebaeudeAssets.active, retiredOn: gebaeudeAssets.retiredOn, categoryName: gebaeudeAssetCategories.name })
      .from(gebaeudeAssets)
      .innerJoin(gebaeudeAssetCategories, eq(gebaeudeAssetCategories.id, gebaeudeAssets.categoryId))
      .where(eq(gebaeudeAssets.id, assetId));
    if (!a) throw new ValidationError({ code: "Inventar gibt es nicht" });
    const [item] = await tx
      .select()
      .from(gebaeudeInventoryItems)
      .where(and(eq(gebaeudeInventoryItems.inventoryId, inventoryId), eq(gebaeudeInventoryItems.assetId, assetId)));
    const base = { assetId: a.id, name: a.name, inventoryNo: a.inventoryNo, roomLabel: inv.roomLabel };
    if (item && item.state !== "offen" && item.state !== "fehlt")
      return { ...base, itemId: item.id, state: item.state, homeRoomId: item.homeRoomId, already: true, roomId: inv.roomId };
    if (!a.active || a.retiredOn) throw new ValidationError({ code: `${a.name} ist ausgemustert – bitte im Inventar prüfen` });
    const now = new Date();
    if (item) {
      const counted = item.quantity > 1 ? (item.counted ?? item.quantity) : null;
      await tx.update(gebaeudeInventoryItems).set({ state: "gefunden", counted, method, recordedAt: now }).where(eq(gebaeudeInventoryItems.id, item.id));
      return { ...base, itemId: item.id, state: "gefunden" as const, homeRoomId: null, already: false, roomId: inv.roomId };
    }
    const here = a.roomId !== null && a.roomId === inv.roomId;
    const state: InventoryItemState = here ? "gefunden" : "falscher_raum";
    const [row] = await tx
      .insert(gebaeudeInventoryItems)
      .values({
        inventoryId,
        assetId: a.id,
        inventoryNo: a.inventoryNo,
        name: a.name,
        categoryName: a.categoryName,
        expected: false,
        quantity: a.quantity,
        counted: a.quantity > 1 ? a.quantity : null,
        homeRoomId: here ? null : a.roomId,
        state,
        method,
        recordedAt: now,
      })
      .returning({ id: gebaeudeInventoryItems.id });
    return { ...base, itemId: row!.id, state, homeRoomId: here ? null : a.roomId, already: false, roomId: inv.roomId };
  });
  if (!res.already) await audit(db, viewer.userId, "gebaeude.asset.inventur", res.assetId, { inventory: inventoryId, room: res.roomId, state: res.state, method });
  return { itemId: res.itemId, assetId: res.assetId, name: res.name, inventoryNo: res.inventoryNo, state: res.state, homeRoomId: res.homeRoomId, already: res.already, roomLabel: res.roomLabel };
}

/**
 * Scan bzw. Eingabe der Inventurseite auflösen: Kurz-URL/Code eines Inventar-Etiketts oder Inventarnummer (ohne Groß-/Kleinschreibung).
 * Raum-Etiketten und Unbekanntes → Hinweis; wer keinen Code kennt, erfährt nichts über fremde Codes (Recht ist schon geprüft).
 */
export async function scanInput(db: Db, viewer: PermissionSet, inventoryId: string, raw: string): Promise<ScanResult> {
  requireRun(viewer);
  const input = parseScanInput(raw);
  if (!input.value) throw new ValidationError({ code: "Code oder Inventarnummer eingeben" });
  if (input.kind === "raum") throw new ValidationError({ code: "Das ist ein Raum-Etikett, kein Inventar-Etikett" });
  let assetId = await resolveLabelCode(db, "inventar", input.value);
  if (!assetId && input.kind === "text") {
    const [a] = await db
      .select({ id: gebaeudeAssets.id })
      .from(gebaeudeAssets)
      .where(sql`lower(${gebaeudeAssets.inventoryNo}) = ${input.value.toLowerCase()}`);
    assetId = a?.id ?? null;
  }
  if (!assetId) throw new ValidationError({ code: "Kein Inventar zu diesem Code bzw. dieser Nummer" });
  return scanAsset(db, viewer, inventoryId, assetId, "scan");
}

/**
 * Posten von Hand setzen (Knopf in der Liste): gefunden (Sammelposten mit gezählter Menge; 0 = fehlt), fehlt oder zurück auf offen.
 * Nur Soll-Posten bzw. eigene Funde; „falscher Raum“ lässt sich nur übernehmen oder zurücksetzen.
 */
export async function setInventoryItem(db: Db, viewer: PermissionSet, itemId: string, rawState: string, rawCounted?: string | number | null): Promise<string> {
  requireRun(viewer);
  if (!["gefunden", "fehlt", "offen"].includes(rawState)) throw new ValidationError({ state: "Stand wählen" });
  let state = rawState as "gefunden" | "fehlt" | "offen";
  const res = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const [item] = await tx.select().from(gebaeudeInventoryItems).where(eq(gebaeudeInventoryItems.id, itemId));
    if (!item) throw new ValidationError({ state: "Posten gibt es nicht" });
    const inv = await lockOpen(tx, item.inventoryId);
    if (!item.expected && state !== "offen") throw new ValidationError({ state: "Gerät aus einem anderen Raum: übernehmen oder zurücksetzen" });
    let counted: number | null = null;
    if (state === "gefunden" && item.quantity > 1) {
      const txt = rawCounted === null || rawCounted === undefined ? "" : String(rawCounted).trim();
      counted = txt === "" ? item.quantity : Number(txt);
      if (!Number.isInteger(counted) || counted < 0 || counted > INVENTORY_MAX_COUNT) throw new ValidationError({ counted: "Gezählte Menge: ganze Zahl ab 0" });
      if (counted === 0) state = "fehlt";
    }
    if (state === "offen" && !item.expected) {
      // eigener Fund zurückgenommen: Posten entfällt
      await tx.delete(gebaeudeInventoryItems).where(eq(gebaeudeInventoryItems.id, item.id));
    } else {
      await tx
        .update(gebaeudeInventoryItems)
        .set({ state, counted: state === "gefunden" ? counted : state === "fehlt" && item.quantity > 1 ? 0 : null, method: state === "offen" ? null : "liste", recordedAt: state === "offen" ? null : new Date() })
        .where(eq(gebaeudeInventoryItems.id, item.id));
    }
    return { inventoryId: inv.id, roomId: inv.roomId, assetId: item.assetId };
  });
  if (res.assetId) await audit(db, viewer.userId, "gebaeude.asset.inventur", res.assetId, { inventory: res.inventoryId, room: res.roomId, state, method: "liste" });
  return res.inventoryId;
}

/** Gerät aus einem anderen Raum in den Inventurraum übernehmen (Umzug wie auf der Geräteseite, Audit `gebaeude.asset.move`). */
export async function adoptInventoryItem(db: Db, viewer: PermissionSet, itemId: string): Promise<string> {
  requireRun(viewer);
  const [item] = await db.select().from(gebaeudeInventoryItems).where(eq(gebaeudeInventoryItems.id, itemId));
  if (!item) throw new ValidationError({ state: "Posten gibt es nicht" });
  if (item.state !== "falscher_raum" || !item.assetId) throw new ValidationError({ state: "Nur Geräte aus einem anderen Raum lassen sich übernehmen" });
  const [inv] = await db.select().from(gebaeudeInventories).where(eq(gebaeudeInventories.id, item.inventoryId));
  if (!inv || inv.closedAt) throw new ValidationError({ inventory: "Die Inventur ist abgeschlossen" });
  if (!inv.roomId) throw new ValidationError({ inventory: "Den Raum der Inventur gibt es nicht mehr" });
  await moveAsset(db, viewer, item.assetId, inv.roomId);
  await db.update(gebaeudeInventoryItems).set({ state: "umgezogen", recordedAt: new Date() }).where(eq(gebaeudeInventoryItems.id, item.id));
  await audit(db, viewer.userId, "gebaeude.asset.inventur", item.assetId, { inventory: inv.id, room: inv.roomId, state: "umgezogen", method: "liste" });
  return inv.id;
}

/** Abschließen: alles Offene wird „fehlt“. Das Inventar selbst bleibt unverändert (Ausmustern/Umzug entscheiden die Pflegenden). */
export async function closeInventory(db: Db, viewer: PermissionSet, id: string): Promise<InventorySummary> {
  requireRun(viewer);
  const summary = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await lockOpen(tx, id);
    await tx
      .update(gebaeudeInventoryItems)
      .set({ state: "fehlt", counted: sql`case when ${gebaeudeInventoryItems.quantity} > 1 then 0 else null end` })
      .where(and(eq(gebaeudeInventoryItems.inventoryId, id), eq(gebaeudeInventoryItems.state, "offen")));
    await tx.update(gebaeudeInventories).set({ closedAt: new Date() }).where(eq(gebaeudeInventories.id, id));
    return summarizeInventory(await itemsOf(tx, [id]));
  });
  await audit(db, viewer.userId, "gebaeude.inventory.close", id, { expected: summary.expected, found: summary.found, missing: summary.missing, wrongRoom: summary.wrongRoom });
  return summary;
}

/** Löschen: laufende Inventur abbrechen (wer durchführen darf); abgeschlossene Protokolle sind Nachweis – nur `gebaeude.configure`. */
export async function deleteInventory(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  requireRun(viewer);
  const [inv] = await db.select().from(gebaeudeInventories).where(eq(gebaeudeInventories.id, id));
  if (!inv) throw new ValidationError({ inventory: "Inventur gibt es nicht" });
  if (inv.closedAt && !canConfigure(viewer)) throw new ForbiddenError("gebaeude.configure");
  await db.delete(gebaeudeInventories).where(eq(gebaeudeInventories.id, id));
  await audit(db, viewer.userId, "gebaeude.inventory.delete", id, { room: inv.roomId, closed: inv.closedAt !== null });
}

// ---------------------------------------------------------------- Geräteseite

export interface AssetInventoryOption {
  inventoryId: string;
  roomId: string | null;
  roomLabel: string;
  /** Inventur im Raum des Geräts */
  sameRoom: boolean;
  /** Stand des Geräts in dieser Inventur (null = nicht im Soll, noch nicht erfasst) */
  state: InventoryItemState | null;
}

/**
 * Laufende Inventuren für die Geräteseite (Ziel des Etiketts): wer durchführen darf, sieht je laufender Inventur einen Knopf
 * „gefunden in …“ – die im Raum des Geräts zuerst. Ohne Recht leer.
 */
export async function openInventoriesForAsset(db: Db, viewer: PermissionSet, asset: { id: string; roomId: string | null }, limit = 6): Promise<AssetInventoryOption[]> {
  if (!canRunInventory(viewer)) return [];
  const open = await db.select().from(gebaeudeInventories).where(isNull(gebaeudeInventories.closedAt)).orderBy(desc(gebaeudeInventories.startedAt));
  if (open.length === 0) return [];
  const items = await db
    .select({ inventoryId: gebaeudeInventoryItems.inventoryId, state: gebaeudeInventoryItems.state })
    .from(gebaeudeInventoryItems)
    .where(and(eq(gebaeudeInventoryItems.assetId, asset.id), inArray(gebaeudeInventoryItems.inventoryId, open.map((i) => i.id))));
  const stateOf = new Map(items.map((i) => [i.inventoryId, i.state]));
  return open
    .map((i) => ({ inventoryId: i.id, roomId: i.roomId, roomLabel: i.roomLabel, sameRoom: asset.roomId !== null && i.roomId === asset.roomId, state: stateOf.get(i.id) ?? null }))
    .sort((a, b) => Number(b.sameRoom) - Number(a.sameRoom))
    .slice(0, limit);
}

// ---------------------------------------------------------------- Protokoll

const stampFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ });

/** Rein: Dateiname des Protokolls, z. B. `inventur-112-2026-11-02.csv`. */
export function inventoryFileName(roomId: string | null, startedAt: Date): string {
  const room = (roomId ?? "raum").replace(/[^0-9A-Za-z_-]+/g, "_").slice(0, 40) || "raum";
  return `inventur-${room}-${dayFmt.format(startedAt)}`;
}

/**
 * Protokoll als CSV (Semikolon, UTF-8 mit BOM, Zellen gegen Formeln entschärft über `toCsv`) – ohne Personennamen: wer erfasst
 * hat, steht nur im Audit-Log.
 */
export async function inventoryCsv(db: Db, viewer: PermissionSet, id: string): Promise<{ filename: string; body: string } | null> {
  const inv = await getInventory(db, viewer, id);
  if (!inv) return null;
  const header = ["Raum", "begonnen", "abgeschlossen", "Inventarnummer", "Bezeichnung", "Kategorie", "im Soll", "Soll-Menge", "Ist-Menge", "Stand", "Raum laut Inventar", "erfasst am", "erfasst über"];
  const rows = inv.items.map((i) => [
    inv.roomLabel,
    stampFmt.format(inv.startedAt),
    inv.closedAt ? stampFmt.format(inv.closedAt) : "",
    i.inventoryNo,
    i.name,
    i.categoryName,
    i.expected ? "ja" : "nein",
    i.quantity,
    i.counted ?? (i.state === "gefunden" || i.state === "umgezogen" ? i.quantity : i.state === "fehlt" ? 0 : ""),
    INVENTORY_ITEM_STATE_LABELS[i.state],
    i.homeRoomId,
    i.recordedAt ? stampFmt.format(i.recordedAt) : "",
    i.method ? INVENTORY_METHOD_LABELS[i.method] : "",
  ]);
  return { filename: `${inventoryFileName(inv.roomId, inv.startedAt)}.csv`, body: toCsv([header, ...rows]) };
}
