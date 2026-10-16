import { moduleOffResponse } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { apiUser } from "@/core/auth/session";
import { acquireExportSlot, exportBusyResponse, exportRequestError, zipResponse } from "@/core/export-limit";
import { hasPermission } from "@/core/permissions";
import { exportClassbookArchive } from "@/modules/klassenbuch/archiv";
import { ValidationError } from "@/modules/verwaltung/users";

export const dynamic = "force-dynamic";

/**
 * Archivexport eines Klassenbuchs als ZIP – nur mit verwaltung.privacy, nicht auf dem Server abgelegt, im Audit-Log.
 * Nur per POST (SEC-05): der Export setzt den Archivvermerk – ein eingebettetes Bild darf das nicht auslösen.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const off = await moduleOffResponse("klassenbuch");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const db = await getDb();
  if (!hasPermission(me.perms, "verwaltung.privacy")) return new Response("Kein Zugriff", { status: 403 });
  const { id } = await params;
  const slot = acquireExportSlot(`archiv:${me.userId}`);
  if (!slot.ok) return exportBusyResponse(slot);
  try {
    const { filename, zip } = await exportClassbookArchive(db, me.userId, decodeURIComponent(id));
    return zipResponse(zip, filename);
  } catch (err) {
    if (err instanceof ValidationError) return new Response("Nicht gefunden", { status: 404 });
    throw err;
  } finally {
    slot.release();
  }
}

export function GET(req: Request) {
  return exportRequestError(req)!;
}
