import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { APPLY_ERRORS, boardRequest, json, readBody } from "@/modules/tafeln/api";
import { syncBoard } from "@/modules/tafeln/live";

export const dynamic = "force-dynamic";

/**
 * Voller Stand (P3-12): alle Elemente inkl. Grabsteine, Hintergrund, Anwesende, `canWrite`, `title`. Der Client ruft ihn beim
 * Öffnen, bei jedem (Neu-)Aufbau der Live-Verbindung, beim Sichtbarwerden des Tabs und alle zwei Minuten und schickt danach
 * zurück, was bei ihm neuer ist (höchstens 30/min je Person und Tafel, sonst 429). POST (nicht GET), damit dieselbe CSRF-Prüfung greift und nichts zwischengespeichert wird.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const r = await boardRequest(req, id);
  if (r instanceof Response) return r;
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const result = await syncBoard(await getDb(), getStorage(), id, r.userId);
  if (typeof result === "string") {
    const e = APPLY_ERRORS[result];
    return json({ error: e.error }, e.status);
  }
  return json({ ...result, canWrite: r.access.canWrite, title: r.access.title });
}
