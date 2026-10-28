// SP3-09a: Jahreswahl im Planungsbereich – gespeichert als Sitzungs-Cookie (nur Pfad /planung), gesetzt über die Route
// `/planung/planungsjahr?jahr=<id>&weiter=<pfad>` (Kopf des Planungsbereichs, Deeplinks). Ein Cookie statt eines URL-Parameters, weil
// die Planungsseiten untereinander viele Links ohne Jahr haben (Reiter, Ansichten, Rücksprünge der Actions) – so bleibt die Wahl beim
// Wechseln der Seite erhalten. Deeplinks tragen `jahr=<id>` bzw. einen Entwurf (`quelle=`/`version=`), der sein Jahr kennt: Weicht das
// vom Cookie ab, stellt die Seite die Wahl über die Route um und kommt zurück (siehe `planningYearForPage`).
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Db } from "@/core/db/client";
import { resolvePlanningYear, type PlanningYearState } from "@/modules/stundenplan/planungsjahr";

export const PLANNING_YEAR_COOKIE = "schulos-planungsjahr";
export const PLANNING_YEAR_ROUTE = "/planung/planungsjahr";

/** Link, der das Planungsjahr umstellt und danach `weiter` öffnet (nur Pfade unter /planung). */
export const switchYearHref = (yearId: string, weiter: string) => `${PLANNING_YEAR_ROUTE}?jahr=${encodeURIComponent(yearId)}&weiter=${encodeURIComponent(weiter)}`;

/** Gewähltes Planungsjahr laut Cookie (Vorgabe: das laufende Schuljahr). */
export async function selectedPlanningYear(db: Db): Promise<PlanningYearState | null> {
  return resolvePlanningYear(db, (await cookies()).get(PLANNING_YEAR_COOKIE)?.value ?? null);
}

/**
 * Planungsjahr einer Seite: `derivedYearId` (Schuljahr eines Entwurfs aus der URL) bzw. `?jahr=` gehen vor; weichen sie von der Wahl ab,
 * wird über die Route umgestellt (Weiterleitung, danach dieselbe Seite ohne `jahr`). Ohne jedes Schuljahr `null`.
 */
export async function planningYearForPage(db: Db, path: string, sp: Record<string, string | string[] | undefined>, derivedYearId?: string | null): Promise<PlanningYearState | null> {
  const state = await selectedPlanningYear(db);
  if (!state) return null;
  const want = derivedYearId ?? (typeof sp.jahr === "string" ? sp.jahr : null);
  if (want && want !== state.year.id && state.choices.some((c) => c.id === want)) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "jahr" || v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
    }
    const s = q.toString();
    redirect(switchYearHref(want, `${path}${s ? `?${s}` : ""}`));
  }
  return state;
}
