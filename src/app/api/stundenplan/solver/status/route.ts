import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { PLAN_MANAGE } from "@/modules/stundenplan/rechte";
import { runLiveStates } from "@/modules/stundenplan/solverlauf";

export const dynamic = "force-dynamic";

/**
 * SP-07: Live-Zustand wartender/rechnender Solver-Läufe (`?ids=a,b`) – Status, Fortschritt, letzter Protokolleintrag. Die Seiten
 * fragen hier alle paar Sekunden nach (statt sich ganz neu zu laden) und laden erst neu, wenn sich ein Status ändert.
 */
export async function GET(req: Request) {
  const off = await moduleOffResponse("stundenplan");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  if (!hasPermission(me.perms, PLAN_MANAGE)) return Response.json({ error: "Keine Berechtigung" }, { status: 403 });
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
  const runs = await runLiveStates(await getDb(), ids);
  return Response.json({ runs }, { headers: { "Cache-Control": "private, no-store" } });
}
