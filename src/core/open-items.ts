// „Offen für dich“ (Q5-07, I-10/I-27): Rahmen für das Heute-Widget mit offenen Handgriffen. Jedes Modul liefert über einen
// Lieferanten seine Punkte für die angemeldete Person (wie die Suchanbieter, src/modules/open-items.ts). Regeln:
// nur Zähler und eigene Vorgänge – nie eine Auswertung über andere Lehrkräfte (DATENSCHUTZ §5); Lieferanten prüfen
// Rolle/Rechte selbst und lesen nur, was die Person auch auf der verlinkten Seite sehen darf.
import type { CurrentUser } from "@/core/auth/session";
import type { Db } from "@/core/db/client";
import { isEnabled, type ModuleStateMap } from "@/core/modules/registry";
import type { ModuleManifest } from "@/core/modules/types";

export interface OpenItem {
  /** eindeutig je Lieferant, z. B. „elternbriefe:bestaetigen“ */
  id: string;
  moduleId: string;
  label: string;
  /** Zahl im Badge (fehlt bei Ja/Nein-Punkten wie „Sicherung überfällig“) */
  count?: number;
  /** eine kurze Zeile darunter, z. B. „Lea 1 · Max 2“ oder „19 von 27 bestätigt“ */
  detail?: string;
  href: string;
  /** danger = sofort kümmern, warn = wartet auf dich, info = zur Kenntnis */
  tone: "danger" | "warn" | "info";
  /** Elternbrief-Rücklauf: Knopf „Erinnern“ (nur, wenn gerade erlaubt) */
  remindLetterId?: string;
}

export interface OpenItemsProvider {
  moduleId: string;
  collect: (db: Db, current: CurrentUser, now: Date) => Promise<OpenItem[]>;
}

const TONE_ORDER: Record<OpenItem["tone"], number> = { danger: 0, warn: 1, info: 2 };

/** Fragt die Lieferanten aktiver Module parallel ab; ein kaputter Lieferant legt das Widget nicht lahm. */
export async function collectOpenItems(
  db: Db,
  current: CurrentUser,
  providers: readonly OpenItemsProvider[],
  manifests: readonly ModuleManifest[],
  states: ModuleStateMap,
  now = new Date(),
): Promise<OpenItem[]> {
  const active = providers.filter((p) => {
    const m = manifests.find((x) => x.id === p.moduleId);
    return m !== undefined && isEnabled(m, states);
  });
  const results = await Promise.allSettled(active.map((p) => p.collect(db, current, now)));
  const items = results.flatMap((r) => {
    if (r.status === "fulfilled") return r.value;
    console.error("[offen] Lieferant fehlgeschlagen:", r.reason);
    return [];
  });
  return items.filter((i) => i.count === undefined || i.count > 0).sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}
