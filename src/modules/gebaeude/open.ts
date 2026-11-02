// INV-06 „Offen für dich“: Garantie bzw. Zweckbindung von Inventar endet bald (inv-9: nur ein Hinweis, keine Förderabrechnung).
// Nur für die Pflegenden der jeweiligen Kategorien (`gebaeude.inventory`/`configure` bzw. verantwortliche Gruppe) – sie können
// rechtzeitig Garantiefälle melden bzw. die Weiternutzung klären. Vorlauf als Moduleinstellung, kein Gong, keine Mail.
// Kein Personenbezug: Gerätebezeichnungen und Zahlen.
import type { Db } from "@/core/db/client";
import { readModuleSetting } from "@/core/modules/settings";
import type { OpenItem, OpenItemsProvider } from "@/core/open-items";
import type { PermissionSet } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { maintainableCategories } from "./inventar";
import { formatDay, listAssets } from "./pruefungen";
import { DEADLINE_DAYS } from "./settings";

export type DeadlineKind = "garantie" | "zweckbindung";
export const DEADLINE_KINDS: readonly DeadlineKind[] = ["garantie", "zweckbindung"];
export const DEADLINE_LABELS: Record<DeadlineKind, string> = { garantie: "Garantie läuft ab", zweckbindung: "Zweckbindung endet" };

/** Vorlauf in Tagen (0 = aus). */
export async function deadlineDays(db: Db): Promise<number> {
  const n = Number(await readModuleSetting(db, DEADLINE_DAYS));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Zeitraum für den Filter „Frist“ der Inventarliste: heute bis heute + Vorlauf (abgelaufene zählen nicht mehr). */
export async function deadlineWindow(db: Db, today: string): Promise<{ from: string; until: string; days: number } | null> {
  const days = await deadlineDays(db);
  return days ? { from: today, until: addDays(today, days), days } : null;
}

/** Rein: ein Punkt je Fristart (Anzahl, die ersten zwei Geräte, frühestes Datum). */
export function deadlineItem(kind: DeadlineKind, assets: readonly { name: string; date: string | null }[]): OpenItem | null {
  if (assets.length === 0) return null;
  const sorted = [...assets].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.name.localeCompare(b.name, "de"));
  const names = sorted
    .slice(0, 2)
    .map((a) => a.name)
    .join(" · ");
  return {
    id: `gebaeude:${kind}`,
    moduleId: "gebaeude",
    label: DEADLINE_LABELS[kind],
    count: assets.length,
    detail: `${names}${assets.length > 2 ? " …" : ""} · ab ${formatDay(sorted[0]!.date!)}`,
    href: `/gebaeude/inventar?frist=${kind}`,
    tone: kind === "garantie" ? "warn" : "info",
  };
}

/** Punkte für eine Person (leer ohne Pflegerecht oder bei abgeschaltetem Hinweis). */
export async function inventoryDeadlineItems(db: Db, perms: PermissionSet, now: Date): Promise<OpenItem[]> {
  const own = await maintainableCategories(db, perms);
  if (own && own.size === 0) return [];
  const win = await deadlineWindow(db, toBerlinDate(now));
  if (!win) return [];
  const items: OpenItem[] = [];
  for (const kind of DEADLINE_KINDS) {
    // `listAssets` liest für `view_all` alle Kategorien – der Hinweis gilt aber nur für die eigenen
    const rows = (await listAssets(db, perms, { deadline: { kind, from: win.from, until: win.until } })).filter((a) => own === null || own.has(a.categoryId));
    const item = deadlineItem(
      kind,
      rows.map((a) => ({ name: a.name, date: kind === "garantie" ? a.warrantyUntil : a.boundUntil })),
    );
    if (item) items.push(item);
  }
  return items;
}

export const gebaeudeOpen: OpenItemsProvider = {
  moduleId: "gebaeude",
  collect: (db, { perms }, now) => inventoryDeadlineItems(db, perms, now),
};
