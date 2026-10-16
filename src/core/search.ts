import type { CurrentUser } from "@/core/auth/session";
import type { Db } from "@/core/db/client";
import { isEnabled, type ModuleStateMap } from "@/core/modules/registry";
import type { ModuleManifest } from "@/core/modules/types";

export interface SearchHit {
  /** Überschrift der Gruppe in der Palette, z. B. „Personen" */
  group: string;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  /** lucide-Icon-Name oder Kürzel/Initialen für einen Avatar */
  icon?: string;
  avatar?: string;
}

export interface SearchProvider {
  moduleId: string;
  search: (db: Db, current: CurrentUser, q: string) => Promise<SearchHit[]>;
}

/** Fragt alle Provider aktiver Module parallel ab. Ein kaputter Provider legt die Suche nicht lahm. */
export async function globalSearch(
  db: Db,
  current: CurrentUser,
  q: string,
  providers: readonly SearchProvider[],
  manifests: readonly ModuleManifest[],
  states: ModuleStateMap,
): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const active = providers.filter((p) => {
    const m = manifests.find((x) => x.id === p.moduleId);
    return m !== undefined && isEnabled(m, states);
  });
  const results = await Promise.allSettled(active.map((p) => p.search(db, current, term)));
  return results.flatMap((r) => {
    if (r.status === "fulfilled") return r.value;
    console.error("[suche] Provider fehlgeschlagen:", r.reason);
    return [];
  });
}
