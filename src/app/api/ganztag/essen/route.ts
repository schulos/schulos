import { apiUser } from "@/core/auth/session";
import { toCsv } from "@/core/csv";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { addDays, mondayOf, toBerlinDate } from "@/core/time";
import { canSeeCounts, kitchenCsvRows } from "@/modules/ganztag/essen";
import { ValidationError } from "@/modules/verwaltung/users";

export const dynamic = "force-dynamic";

/** GT-12: Anmeldungen je Tag und Menü als CSV für die Küche – nur Zahlen, keine Namen. Ohne Recht 404 (wie die Seite). */
export async function GET(req: Request) {
  const off = await moduleOffResponse("ganztag");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  if (!canSeeCounts(me.perms)) return new Response("Nicht gefunden", { status: 404 });
  const url = new URL(req.url);
  const monday = mondayOf(toBerlinDate(new Date()));
  const from = url.searchParams.get("von") ?? monday;
  const to = url.searchParams.get("bis") ?? addDays(monday, 4);
  try {
    const rows = await kitchenCsvRows(await getDb(), me.perms, from, to);
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ganztag-essen-${from}-${to}.csv"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) return new Response(Object.values(err.fieldErrors)[0] ?? "Ungültig", { status: 400 });
    throw err;
  }
}
