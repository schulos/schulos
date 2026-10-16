import { getDb } from "@/core/db/client";
import { APPLY_ERRORS, json, readBody, textRequest } from "@/modules/texte/api";
import { applyClientUpdate } from "@/modules/texte/live";

export const dynamic = "force-dynamic";

/**
 * Yjs-Update eines Clients (P3-11): Body `{ update: <Base64> }`. Rechte bei jedem Aufruf: Modul an, Sitzung nutzbar,
 * Mitglied der Gruppe mit Merkmal, Schreibrecht (Modus, Gruppe nicht archiviert). Antwort: Anwesende und Hinweis ab ~30.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const r = await textRequest(req, id);
  if (r instanceof Response) return r;
  if (!r.access.canWrite) return json({ error: "Nur lesen" }, 403);
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const result = await applyClientUpdate(await getDb(), id, r.userId, body.update);
  if (!result.ok) {
    const e = APPLY_ERRORS[result.error];
    return json({ error: e.error }, e.status);
  }
  return json({ ok: true, editors: result.editors, crowded: result.crowded, changed: result.changed });
}
