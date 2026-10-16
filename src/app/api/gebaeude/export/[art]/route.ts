import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { inspectionsCsv, ticketsCsv } from "@/modules/gebaeude/pruefungen";

export const dynamic = "force-dynamic";

/** P4-18: CSV der Meldungen bzw. Prüfungen – ohne Personennamen und Freitext, Zellen gegen Formeln entschärft. */
export async function GET(req: Request, { params }: { params: Promise<{ art: string }> }) {
  const off = await moduleOffResponse("gebaeude");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { art } = await params;
  if (art !== "meldungen" && art !== "pruefungen") return new Response("Nicht gefunden", { status: 404 });
  const db = await getDb();
  const today = toBerlinDate(new Date());
  try {
    const body = art === "meldungen" ? await ticketsCsv(db, me.perms) : await inspectionsCsv(db, me.perms, today);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="gebaeude-${art}-${today}.csv"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Nicht gefunden", { status: 404 });
    throw err;
  }
}
