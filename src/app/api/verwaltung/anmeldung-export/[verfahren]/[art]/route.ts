import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { exportRequestError } from "@/core/export-limit";
import { moduleOffResponse } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { exportSerienbriefCsv, exportSvsCsv } from "@/modules/anmeldung/entscheidung";
import { ValidationError } from "@/modules/verwaltung/users";

export const dynamic = "force-dynamic";

/**
 * P4-37: CSV-Exporte der Schulanmeldung – „svs“ (Schulverwaltungssoftware, Spalten/Kodierung/Auswahl aus dem Formular) und
 * „serienbrief“ (Bescheide). Bewusst nicht unter `/api/anmeldung*` (das wird mit P4-40 von außen erreichbar). Nur per POST
 * aus dem Formular (SEC-05), Rechte im Service, jeder Export im Audit-Log.
 */
export async function POST(req: Request, { params }: { params: Promise<{ verfahren: string; art: string }> }) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const off = await moduleOffResponse("anmeldung");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { verfahren, art } = await params;
  if (art !== "svs" && art !== "serienbrief") return new Response("Nicht gefunden", { status: 404 });
  const form = await req.formData().catch(() => new FormData());
  const encoding = String(form.get("encoding") ?? "utf8");
  const db = await getDb();
  try {
    const r =
      art === "svs"
        ? await exportSvsCsv(db, me.perms, decodeURIComponent(verfahren), { columns: form.getAll("col").map(String), encoding, scope: String(form.get("scope") ?? "") })
        : await exportSerienbriefCsv(db, me.perms, decodeURIComponent(verfahren), encoding);
    return new Response(Buffer.from(r.body), {
      headers: {
        "Content-Type": `text/csv; charset=${r.encoding === "cp1252" ? "windows-1252" : "utf-8"}`,
        "Content-Disposition": `attachment; filename="${r.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Nicht gefunden", { status: 404 });
    if (err instanceof ValidationError) return new Response(Object.values(err.fieldErrors)[0], { status: 400 });
    throw err;
  }
}

export function GET(req: Request) {
  return exportRequestError(req)!;
}
