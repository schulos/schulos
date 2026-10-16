import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { exportRequestError } from "@/core/export-limit";
import { hasPermission } from "@/core/permissions";
import { setupExport } from "@/core/privacy/einrichtung";
import { readSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";

export const dynamic = "force-dynamic";

/**
 * DS-12: Nachweis der Datenschutz-Einrichtung als JSON („Datenschutz-Konfiguration Stand …“) – nur mit verwaltung.privacy,
 * nur per POST (wie alle protokollierten Exporte, S18), steht im Audit-Log.
 */
export async function POST(req: Request) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  if (!hasPermission(me.perms, "verwaltung.privacy")) return new Response("Kein Zugriff", { status: 403 });
  const db = await getDb();
  const now = new Date();
  const body = await setupExport(db, me.userId, (await readSchoolSettings(db)).name, now);
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="datenschutz-konfiguration-${toBerlinDate(now)}.json"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export function GET(req: Request) {
  return exportRequestError(req)!;
}
