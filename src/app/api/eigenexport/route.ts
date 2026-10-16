import { getDb } from "@/core/db/client";
import { apiUser } from "@/core/auth/session";
import { getStorage } from "@/core/files/storage";
import { acquireExportSlot, EXPORT_LIMITS, exportBusyResponse, exportRequestError, ExportTooLargeError, zipResponse } from "@/core/export-limit";
import { buildOwnExport } from "@/core/privacy/eigenexport";

export const dynamic = "force-dynamic";

/** „Meine Dateien und Abgaben herunterladen“ (Art. 20) – jede angemeldete Person nur für sich selbst; nur per POST (SEC-05). */
export async function POST(req: Request) {
  const bad = exportRequestError(req);
  if (bad) return bad;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const slot = acquireExportSlot(`eigenexport:${me.userId}`, { minIntervalMs: EXPORT_LIMITS.ownExportIntervalMs });
  if (!slot.ok) return exportBusyResponse(slot);
  try {
    const res = await buildOwnExport(await getDb(), getStorage(), me.userId);
    return zipResponse(res.zip, res.filename);
  } catch (err) {
    if (err instanceof ExportTooLargeError) return new Response(`${err.message}. Bitte Dateien einzeln herunterladen.`, { status: 413 });
    throw err;
  } finally {
    slot.release();
  }
}

/** GET löst nichts aus – sonst könnte ein eingebettetes Bild (`<img src=/api/eigenexport>`) Exporte starten. */
export function GET(req: Request) {
  return exportRequestError(req)!;
}
