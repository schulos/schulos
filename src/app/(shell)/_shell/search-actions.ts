"use server";

import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadModuleStates } from "@/core/modules/registry";
import { globalSearch, type SearchHit } from "@/core/search";
import { MODULES } from "@/modules";
import { SEARCH_PROVIDERS } from "@/modules/search";

export async function searchAction(q: string): Promise<SearchHit[]> {
  const current = await requireUser();
  const db = await getDb();
  return globalSearch(db, current, q.slice(0, 100), SEARCH_PROVIDERS, MODULES, await loadModuleStates(db));
}
