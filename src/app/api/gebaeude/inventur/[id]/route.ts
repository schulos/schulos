import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { inventoryCsv } from "@/modules/gebaeude/inventur";

export const dynamic = "force-dynamic";

/** INV-04: Inventurprotokoll als CSV – ohne Personennamen, Zellen gegen Formeln entschärft; ohne Leserecht wie unbekannt (404). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("gebaeude");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  try {
    const csv = await inventoryCsv(await getDb(), me.perms, id);
    if (!csv) return new Response("Nicht gefunden", { status: 404 });
    return new Response(csv.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csv.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Nicht gefunden", { status: 404 });
    throw err;
  }
}
