import { apiUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { floorPlanFile } from "@/modules/verwaltung/grundriss";

export const dynamic = "force-dynamic";

/**
 * RS-13: Grundriss einer Etage – nur für Angemeldete mit Sicht auf Grundrisse (Moduleinstellung „nur Personal“), keine
 * öffentliche URL; sonst einheitlich 404. `?klein=1` liefert das Vorschaubild. Typ fest aus der DB, nie ausführbar (S8-Header).
 */
export async function GET(req: Request, { params }: { params: Promise<{ etage: string }> }) {
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const { etage } = await params;
  const small = new URL(req.url).searchParams.get("klein") === "1";
  const file = await floorPlanFile(await getDb(), me.perms, etage, small);
  if (!file) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(file.key);
  if (!body) return new Response("Datei fehlt im Speicher", { status: 410 });
  return new Response(body, {
    headers: {
      "Content-Type": file.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      // ein ersetzter Plan bekommt per `?v=` eine neue URL; die Sichtbarkeit kann sich mit der Moduleinstellung ändern → kurz und privat
      "Cache-Control": "private, max-age=600",
    },
  });
}
