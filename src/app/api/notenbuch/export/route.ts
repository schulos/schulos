import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { exportRequestError } from "@/core/export-limit";
import { moduleOffResponse } from "@/core/modules/guard";
import { NO_STORE_HEADER } from "@/core/no-store";
import { ForbiddenError } from "@/core/permissions";
import { notenbuchActivity } from "@/modules/notenbuch/guard";
import { noticeAcknowledged } from "@/modules/notenbuch/hinweis";
import { exportTermCsv, notenbuchAccess, NotenbuchTwoFactorError } from "@/modules/notenbuch/service";
import { ValidationError } from "@/modules/verwaltung/users";

export const dynamic = "force-dynamic";

const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE_HEADER } });

/**
 * P5-13: CSV-Export der Halbjahreswerte einer Klasse für die Schulverwaltungssoftware – nur per POST aus dem Formular (SEC-05),
 * Recht `notenbuch.export`, Zwei-Faktor-Pflicht und Inaktivitätsablauf wie die Seiten; jeder Export im Audit-Log. Nie Teilnoten.
 */
export async function POST(req: Request) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const off = await moduleOffResponse("notenbuch");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const db = await getDb();
  // GATE-5a (Schülerzugriff): ohne jedes Notenbuch-Recht (Schüler:innen, Eltern, …) wie nicht vorhanden – vor jeder weiteren
  // Prüfung; das Export-Recht selbst prüft `exportTermCsv`
  if (!(await notenbuchAccess(db, me.perms)).any) return text("Nicht gefunden", 404);
  if (!(await noticeAcknowledged(db, me.userId))) return text("Bitte zuerst den Datenschutzhinweis im Notenbuch bestätigen.", 403);
  const gate = await notenbuchActivity(db, me.userId, req.headers);
  if (gate === "zweiter-faktor") return text("Das Notenbuch verlangt eine Anmeldung mit zweitem Faktor – bitte neu anmelden.", 403);
  if (gate === "locked") return text("Das Notenbuch ist wegen Inaktivität gesperrt – bitte neu anmelden.", 403);
  const form = await req.formData().catch(() => new FormData());
  try {
    const r = await exportTermCsv(
      db,
      me.perms,
      String(form.get("groupId") ?? ""),
      { schoolYearId: String(form.get("schoolYearId") ?? ""), term: Number(form.get("term")) },
      String(form.get("encoding") ?? "utf8"),
    );
    return new Response(Buffer.from(r.body), {
      headers: {
        "Content-Type": `text/csv; charset=${r.encoding === "cp1252" ? "windows-1252" : "utf-8"}`,
        "Content-Disposition": `attachment; filename="${r.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": NO_STORE_HEADER,
      },
    });
  } catch (err) {
    if (err instanceof NotenbuchTwoFactorError) return text(err.message, 403);
    if (err instanceof ForbiddenError) return text("Nicht gefunden", 404);
    if (err instanceof ValidationError) return text(Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", 400);
    throw err;
  }
}

export function GET(req: Request) {
  return exportRequestError(req)!;
}
