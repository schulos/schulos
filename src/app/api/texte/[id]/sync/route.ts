import { getDb } from "@/core/db/client";
import { json, readBody, textRequest } from "@/modules/texte/api";
import { syncDoc } from "@/modules/texte/live";

export const dynamic = "force-dynamic";

/**
 * Abgleich (P3-11): Body `{ sv?: <Base64> }` (Zustandsvektor des Clients; leer = voller Stand). Antwort: `update` (was dem
 * Client fehlt), `sv` (Stand des Servers – der Client liefert damit nach, was dem Server fehlt), `editors`, `crowded`,
 * `canWrite`, `title`. Der Client ruft ihn beim Öffnen, bei jedem (Neu-)Aufbau der Live-Verbindung, beim Sichtbarwerden
 * des Tabs und alle zwei Minuten – damit holt eine Wiederverbindung genau das Verpasste, nicht blind den vollen Stand.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const r = await textRequest(req, id);
  if (r instanceof Response) return r;
  const body = await readBody(req);
  if (body instanceof Response) return body;
  const result = await syncDoc(await getDb(), id, r.userId, body.sv);
  if (result === null) return json({ error: "Nicht gefunden" }, 404);
  if (result === "invalid") return json({ error: "Ungültiger Zustandsvektor" }, 400);
  return json({ ...result, canWrite: r.access.canWrite, title: r.access.doc.title });
}
