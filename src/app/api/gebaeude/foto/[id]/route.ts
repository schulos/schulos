import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { moduleOffResponse } from "@/core/modules/guard";
import { photoFor } from "@/modules/gebaeude/service";

export const dynamic = "force-dynamic";

/** Foto einer Meldung – nur für Melder:in und Bearbeitung; Typ fest aus der DB, nie ausführbar (S8-Header). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("gebaeude");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const photo = await photoFor(await getDb(), me.perms, id);
  if (!photo) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(photo.storageKey);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": photo.mime,
      "Content-Length": String(photo.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
