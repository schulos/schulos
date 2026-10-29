import { apiUser } from "@/core/auth/session";
import { toCsv } from "@/core/csv";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import { canEvaluate, evaluation, evaluationCsvRows } from "@/modules/ganztag/auswertung";

export const dynamic = "force-dynamic";

/** GT-06: Auswertung je Angebot und Monat als CSV – nur Zahlen, keine Namen. Ohne Recht 404 (wie die Seite). */
export async function GET(req: Request) {
  const off = await moduleOffResponse("ganztag");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  if (!canEvaluate(me.perms)) return new Response("Nicht gefunden", { status: 404 });
  const e = await evaluation(await getDb(), me.perms);
  return new Response(toCsv(evaluationCsvRows(e)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ganztag-auswertung-${toBerlinDate(new Date())}.csv"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
