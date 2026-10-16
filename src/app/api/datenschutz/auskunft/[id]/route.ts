import { getDb } from "@/core/db/client";
import { getAuth } from "@/core/auth/auth";
import { apiUser } from "@/core/auth/session";
import { sessionSecondFactorOk } from "@/core/auth/zwei-faktor";
import { getStorage } from "@/core/files/storage";
import { acquireExportSlot, exportBusyResponse, exportRequestError, ExportTooLargeError, zipResponse } from "@/core/export-limit";
import { hasPermission } from "@/core/permissions";
import { buildDataExport } from "@/core/privacy/auskunft";

export const dynamic = "force-dynamic";

/**
 * Auskunft nach Art. 15 als ZIP – nur mit verwaltung.privacy, wird nicht auf dem Server abgelegt, steht im Audit-Log.
 * Nur per POST (SEC-05): ein eingebettetes Bild soll keine Auskunft „erteilen“ (falscher Audit-Eintrag) und keine Last erzeugen.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const db = await getDb();
  if (!hasPermission(me.perms, "verwaltung.privacy")) return new Response("Kein Zugriff", { status: 403 });
  const { id } = await params;
  const slot = acquireExportSlot(`auskunft:${me.userId}`);
  if (!slot.ok) return exportBusyResponse(slot);
  try {
    // G5A-S01: eingeschränkte Teile (Noten aus dem Notenbuch) nur mit ausdrücklichem Recht und Sitzung mit zweitem Faktor
    const session = await (await getAuth()).api.getSession({ headers: req.headers });
    const secondFactor = Boolean(session && (await sessionSecondFactorOk(db, session.session.id, me.userId)));
    const res = await buildDataExport(db, getStorage(), me.userId, decodeURIComponent(id), new Date(), { actor: me.perms, secondFactor });
    if (!res) return new Response("Nicht gefunden", { status: 404 });
    return zipResponse(res.zip, res.filename);
  } catch (err) {
    if (err instanceof ExportTooLargeError) return new Response(err.message, { status: 413 });
    throw err;
  } finally {
    slot.release();
  }
}

export function GET(req: Request) {
  return exportRequestError(req)!;
}
