import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { PLAN_MANAGE } from "@/modules/stundenplan/rechte";
import { assignmentCsvTemplate } from "@/modules/stundenplan/verteilung-import";

export const dynamic = "force-dynamic";

/** SP2-06: Vorlage für den CSV-Import der Unterrichtsverteilung (Kopfzeile + Beispielzeilen mit Kürzeln der Schule). */
export async function GET(req: Request) {
  const off = await moduleOffResponse("stundenplan");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  if (!hasPermission(me.perms, PLAN_MANAGE)) return new Response("Nicht gefunden", { status: 404 });
  return new Response(await assignmentCsvTemplate(await getDb()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="unterrichtsverteilung-vorlage.csv"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
