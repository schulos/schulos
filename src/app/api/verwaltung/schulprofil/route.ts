import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { exportRequestError } from "@/core/export-limit";
import { getStorage } from "@/core/files/storage";
import { hasPermission } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { MODULES } from "@/modules";
import { exportSchulprofil } from "@/modules/verwaltung/schulprofil";

export const dynamic = "force-dynamic";

/**
 * P4-77: Schulprofil als JSON (ohne Personendaten) – für die Vorschau-Instanz. Nur mit `verwaltung.school` **und**
 * `verwaltung.rights` (enthält den Rechte-Zuschnitt), nur per POST (S18), steht im Audit-Log.
 */
export async function POST(req: Request) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  if (!hasPermission(me.perms, "verwaltung.school") || !hasPermission(me.perms, "verwaltung.rights")) return new Response("Kein Zugriff", { status: 403 });
  const now = new Date();
  const body = await exportSchulprofil(await getDb(), getStorage(), MODULES, me.userId, now);
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="schulprofil-${toBerlinDate(now)}.json"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export function GET(req: Request) {
  return exportRequestError(req)!;
}
