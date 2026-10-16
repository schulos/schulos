// Kopplungscode bzw. Ersatz-Kopplungscode für die Kommandozeile im Container (src/intern.ts).
import { appSecret } from "@/auth/auth";
import { getDb } from "@/db/client";
import { internAllowed } from "@/intern";
import { createPairingCode, listInstances } from "@/pairing/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!internAllowed(req.headers, appSecret())) return Response.json({ error: "nicht erlaubt" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { ersatz?: unknown };
  const db = await getDb();
  let replaces: string | null = null;
  if (typeof body.ersatz === "string" && body.ersatz.trim()) {
    const want = body.ersatz.trim().toLowerCase();
    const all = await listInstances(db);
    const hits = all.filter((i) => i.id === body.ersatz || i.name.toLowerCase() === want || i.restUser === want);
    if (hits.length !== 1)
      return Response.json({ error: hits.length ? "Name nicht eindeutig – Kennung angeben" : `Keine Instanz „${body.ersatz}“`, instanzen: all.map((i) => ({ id: i.id, name: i.name })) }, { status: 404 });
    replaces = hits[0]!.id;
  }
  const { code, expiresAt } = await createPairingCode(db, null, appSecret(), new Date(), replaces);
  return Response.json({ code, gueltigBis: expiresAt.toISOString(), ersatzFuer: replaces });
}
