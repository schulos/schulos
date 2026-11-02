// INV-02: Inventar-Etiketten – je Anlage ein nicht erratbarer, stabiler Code für die Kurz-URL `/i/<code>` (Unterbau
// `src/core/etiketten/`). Drucken und Neuerzeugen darf, wer das Inventar der Kategorie pflegt (`requireMaintain`); ohne
// Anmeldung verrät `/i/…` nichts (Seite `src/app/i`). Der Code selbst steht nicht im Audit-Log.
import { eq } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { gebaeudeAssets } from "@/core/db/schema";
import { ensureLabelCodes, labelCodesFor, renewLabelCode } from "@/core/etiketten/service";
import type { PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { canMaintainInventory, maintainableCategories, requireMaintain } from "./inventar";
import { listAssets, type AssetFilter, type AssetRow } from "./pruefungen";

export interface InventoryLabel {
  assetId: string;
  name: string;
  inventoryNo: string;
  categoryName: string;
  place: string;
  quantity: number;
  code: string;
}

/** Darf die Person Etiketten drucken (mindestens eine Kategorie pflegen)? */
export async function canPrintLabels(db: Db, viewer: PermissionSet): Promise<boolean> {
  if (canMaintainInventory(viewer)) return true;
  const own = await maintainableCategories(db, viewer);
  return own !== null && own.size > 0;
}

/** Anlagen, für die die Person Etiketten drucken darf (aktive, pflegbare Kategorien), in Listenreihenfolge. */
export async function printableAssets(db: Db, viewer: PermissionSet, f: AssetFilter = {}): Promise<AssetRow[]> {
  const own = await maintainableCategories(db, viewer);
  if (own && own.size === 0) return [];
  const list = await listAssets(db, viewer, { ...f, inactive: false });
  return own ? list.filter((a) => own.has(a.categoryId)) : list;
}

/**
 * Etiketten für die gewählten Anlagen (nur aktive, nur pflegbare – andere fallen still weg). Fehlende Codes werden angelegt
 * (Audit `gebaeude.asset.qr.create`), vorhandene bleiben – ein Nachdruck passt zum Etikett am Gerät.
 */
export async function inventoryLabels(db: Db, viewer: PermissionSet, assetIds: readonly string[] | "alle", f: AssetFilter = {}): Promise<InventoryLabel[]> {
  const allowed = await printableAssets(db, viewer, f);
  const wanted = assetIds === "alle" ? null : new Set(assetIds);
  const list = wanted ? allowed.filter((a) => wanted.has(a.id)) : allowed;
  if (!list.length) return [];
  const { codes, created } = await ensureLabelCodes(
    db,
    "inventar",
    list.map((a) => a.id),
  );
  for (const id of created) await audit(db, viewer.userId, "gebaeude.asset.qr.create", id, {});
  return list.map((a) => ({
    assetId: a.id,
    name: a.name,
    inventoryNo: a.inventoryNo ?? "",
    categoryName: a.categoryName,
    place: [a.roomId ? `Raum ${a.roomId}` : null, a.building].filter(Boolean).join(" · "),
    quantity: a.quantity,
    code: codes.get(a.id)!,
  }));
}

/** Code der Anlage für die Anzeige – nur für Pflegende, sonst `null`; legt nichts an. */
export async function assetCode(db: Db, viewer: PermissionSet, assetId: string, categoryId: string): Promise<string | null> {
  const own = await maintainableCategories(db, viewer);
  if (own && !own.has(categoryId)) return null;
  return (await labelCodesFor(db, "inventar", [assetId])).get(assetId) ?? null;
}

/** Neuen Code erzeugen (Etikett verloren, Code abfotografiert …): der alte Code führt danach nirgends mehr hin. */
export async function renewAssetCode(db: Db, viewer: PermissionSet, assetId: string): Promise<string> {
  const [a] = await db.select({ id: gebaeudeAssets.id, categoryId: gebaeudeAssets.categoryId }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, assetId));
  if (!a) throw new ValidationError({ asset: "Inventar gibt es nicht" });
  await requireMaintain(db, viewer, a.categoryId);
  const code = await renewLabelCode(db, "inventar", a.id);
  await audit(db, viewer.userId, "gebaeude.asset.qr.renew", a.id, {});
  return code;
}
