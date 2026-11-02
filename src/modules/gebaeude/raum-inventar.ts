// INV-06 / inv-3: Karte „Inventar“ im Raumsteckbrief – Anzahl je Kategorie (Einträge und Stück) mit Link auf die gefilterte
// Inventarliste. Nur für alle, die das Inventar lesen dürfen (`view_all`, Pflegende; verantwortliche Gruppen sehen nur ihre
// Kategorien – wie die Liste). Die grobe Ausstattung des Raums (RS-05) bleibt davon unberührt.
import type { Db } from "@/core/db/client";
import type { PermissionSet } from "@/core/permissions";
import { canSeeInventory } from "./inventar";
import { listAssets } from "./pruefungen";

export interface RoomInventory {
  categories: { id: string; name: string; entries: number; pieces: number }[];
  entries: number;
  pieces: number;
}

/** `null` = keine Sicht aufs Inventar (Karte entfällt). Ausgemustertes zählt nicht. */
export async function roomInventory(db: Db, viewer: PermissionSet, roomId: string): Promise<RoomInventory | null> {
  if (!(await canSeeInventory(db, viewer))) return null;
  const assets = await listAssets(db, viewer, { roomId });
  const byCat = new Map<string, RoomInventory["categories"][number]>();
  for (const a of assets) {
    const c = byCat.get(a.categoryId) ?? { id: a.categoryId, name: a.categoryName, entries: 0, pieces: 0 };
    c.entries++;
    c.pieces += a.quantity;
    byCat.set(a.categoryId, c);
  }
  // listAssets liefert schon in Kategorie-Reihenfolge
  return { categories: [...byCat.values()], entries: assets.length, pieces: assets.reduce((s, a) => s + a.quantity, 0) };
}
