import { apiUser } from "@/core/auth/session";
import { toCsv } from "@/core/csv";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import { buildExport, canExport, isExportArt } from "@/modules/stundenplan/exporte";

export const dynamic = "force-dynamic";

/**
 * SP2-10: CSV der Gesamtübersichten, Unterrichtsverteilung, Deputate, des Aufsichtsplans und der Vertretungsstatistik.
 * Rechte je Art in `canExport`; ohne Recht 404 (wie die Seiten). Zellen sind gegen Formel-Injektion entschärft (`toCsv`).
 */
export async function GET(req: Request, { params }: { params: Promise<{ art: string }> }) {
  const off = await moduleOffResponse("stundenplan");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { art } = await params;
  if (!isExportArt(art) || !canExport(art, me.perms)) return new Response("Nicht gefunden", { status: 404 });
  const today = toBerlinDate(new Date());
  const url = new URL(req.url).searchParams;
  const monat = url.get("zeitraum") === "monat";
  // SP3-09b: Verteilung/Deputate im gewählten Schuljahr (`jahr=`) und gegen einen Entwurf (`quelle=`)
  const table = await buildExport(await getDb(), art, { today, monat, yearId: url.get("jahr"), quelle: url.get("quelle") });
  return new Response(toCsv([table.head, ...table.rows]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${table.filename}-${today}.csv"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
