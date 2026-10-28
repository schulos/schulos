import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { photoFile } from "@/modules/verwaltung/raumfotos";

export const dynamic = "force-dynamic";

/**
 * RS-04: Raumfoto – Titelbild für alle Angemeldeten, übrige Fotos nur für Beschäftigte (`photoFile`); `?klein=1` liefert das
 * Vorschaubild. Räume sind Kernstammdaten (keine Modulsperre). Typ fest aus der DB, nie ausführbar (S8-Header).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { id } = await params;
  const small = new URL(req.url).searchParams.get("klein") === "1";
  const file = await photoFile(await getDb(), me.perms, id, small);
  if (!file) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(file.key);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": file.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      // Fotos werden nie verändert (neues Foto = neue ID); Sichtbarkeit kann sich mit dem Titelbild ändern → kurz und privat
      "Cache-Control": "private, max-age=3600",
    },
  });
}
