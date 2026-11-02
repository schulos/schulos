import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { moduleOffResponse } from "@/core/modules/guard";
import { assetPhotoFile } from "@/modules/gebaeude/asset-seite";

export const dynamic = "force-dynamic";

/**
 * INV-03: Foto eines Inventarguts – nur mit voller Sicht (`view_all` oder Pflegende der Kategorie), sonst einheitlich 404;
 * `?klein=1` liefert das Vorschaubild. Typ fest aus der DB, nie ausführbar (S8-Header, SICHERHEIT S99).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = await moduleOffResponse("gebaeude");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const small = new URL(req.url).searchParams.get("klein") === "1";
  const file = await assetPhotoFile(await getDb(), me.perms, id, small);
  if (!file) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(file.key);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": file.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      // Fotos werden nie verändert (neues Foto = neue ID) – privat zwischenspeichern
      "Cache-Control": "private, max-age=3600",
    },
  });
}
