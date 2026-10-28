// SP3-09a: Planungsjahr umstellen (Kopf des Planungsbereichs, Deeplinks) – setzt das Sitzungs-Cookie und leitet auf `weiter` zurück.
// Nur angemeldet mit einem Planungsrecht; nur bekannte Schuljahre; `weiter` nur unter /planung (keine offene Weiterleitung). Die Wahl
// ändert nur die Ansicht – geschrieben wird immer in das Jahr, das die Seite der Action ausdrücklich mitgibt (planungsjahr.ts im Modul).
import { cookies } from "next/headers";
import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { resolvePlanningYear, safePlanningTarget } from "@/modules/stundenplan/planungsjahr";
import { PLAN_FORECAST, PLAN_MANAGE, PLAN_REVIEW, PLAN_SUBSTITUTE } from "@/modules/stundenplan/rechte";
import { PLANNING_YEAR_COOKIE } from "../planungsjahr";

export async function GET(req: Request): Promise<Response> {
  const off = await moduleOffResponse("stundenplan");
  if (off) return off;
  const u = await apiUser(req);
  if (u instanceof Response) return u;
  if (![PLAN_MANAGE, PLAN_REVIEW, PLAN_SUBSTITUTE, PLAN_FORECAST].some((p) => hasPermission(u.perms, p))) return new Response("Nicht gefunden", { status: 404 });
  const url = new URL(req.url);
  const target = safePlanningTarget(url.searchParams.get("weiter"));
  const state = await resolvePlanningYear(await getDb(), url.searchParams.get("jahr"));
  const jar = await cookies();
  if (state) {
    const https = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
    // Sitzungs-Cookie: nach dem Schließen des Browsers gilt wieder das laufende Schuljahr. Nicht httpOnly – der Kopf des Bereichs liest die
    // Wahl nach Seitenwechseln im Browser (nur eine Schuljahres-id, nichts Geheimes)
    if (state.isBase) jar.delete({ name: PLANNING_YEAR_COOKIE, path: "/planung" });
    else jar.set(PLANNING_YEAR_COOKIE, state.year.id, { path: "/planung", httpOnly: false, sameSite: "lax", secure: https });
  }
  return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
}
