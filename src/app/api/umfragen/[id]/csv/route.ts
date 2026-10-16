import { moduleOffResponse } from "@/core/modules/guard";
import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ForbiddenError } from "@/core/permissions";
import { resultsCsv } from "@/modules/umfragen/teilnahme";
import { ValidationError } from "@/modules/verwaltung/users";

export const dynamic = "force-dynamic";

/** P3-04: Ergebnisse als CSV – nur Ersteller:in/`umfragen.manage`, anonym erst ab 5 Antworten. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("umfragen");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  try {
    const { name, body } = await resultsCsv(await getDb(), me.perms, (await params).id);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Nicht gefunden", { status: 404 });
    if (err instanceof ValidationError) return new Response(Object.values(err.fieldErrors)[0], { status: 409 });
    throw err;
  }
}
