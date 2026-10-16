// Gekoppelte Instanzen für die Kommandozeile im Container (src/intern.ts) – ohne Geheimnisse.
import { appSecret } from "@/auth/auth";
import { getDb } from "@/db/client";
import { internAllowed } from "@/intern";
import { listInstances } from "@/pairing/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!internAllowed(req.headers, appSecret())) return Response.json({ error: "nicht erlaubt" }, { status: 403 });
  const all = await listInstances(await getDb());
  return Response.json(all.map((i) => ({ id: i.id, name: i.name, restUser: i.restUser, hauptsystem: i.mainUrl, gekoppeltAm: i.createdAt })));
}
