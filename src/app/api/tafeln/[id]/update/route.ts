import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { APPLY_ERRORS, boardRequest, json, readBody } from "@/modules/tafeln/api";
import { applyBoardUpdate } from "@/modules/tafeln/live";

export const dynamic = "force-dynamic";

/**
 * Geänderte Elemente eines Clients (P3-12): Body `{ elements: [...] }`. Rechte bei jedem Aufruf: Modul an, Sitzung nutzbar,
 * Mitglied der Gruppe mit Gruppenordner, Gruppe nicht archiviert. Antwort: übernommene und verworfene (ungültige) Anzahl, Anwesende, Hinweis ab ~30.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const r = await boardRequest(req, id);
  if (r instanceof Response) return r;
  if (!r.access.canWrite) return json({ error: "Nur lesen" }, 403);
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const result = await applyBoardUpdate(await getDb(), getStorage(), id, r.userId, body.elements);
  if (!result.ok) {
    const e = APPLY_ERRORS[result.error];
    return json({ error: e.error }, e.status);
  }
  return json({ ok: true, changed: result.changed, dropped: result.dropped, droppedIds: result.droppedIds, editors: result.editors, crowded: result.crowded });
}
