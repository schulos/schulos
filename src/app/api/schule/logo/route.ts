import { getDb } from "@/core/db/client";
import { getStorage } from "@/core/files/storage";
import { parseLogoVariant, readLogos } from "@/core/school/logo";

export const dynamic = "force-dynamic";

/** CSP für das direkte Öffnen der Datei: kein Skript, keine Nachladungen, eigener Ursprung (Schicht 2 der SVG-Absicherung). */
const LOGO_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/**
 * Schullogo – öffentlich (Login, Monitor, Druck, Favicon; `PUBLIC` in src/proxy.ts). `?variante=dark|symbol`, `?v=<hash>`.
 * Content-Type kommt aus dem bei der Annahme ermittelten Typ, nie aus der Datei; eingebunden wird nur per <img>.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const variant = parseLogoVariant(params.get("variante"));
  if (!variant) return new Response("Nicht gefunden", { status: 404 });
  const meta = (await readLogos(await getDb()))[variant];
  if (!meta) return new Response("Nicht gefunden", { status: 404 });
  const body = await getStorage().get(meta.key);
  if (!body) return new Response("Nicht gefunden", { status: 404 });
  // Mit passender Version unveränderlich – ein neues Logo hat eine neue Adresse; ohne/alte Version nur kurz
  const current = params.get("v") === meta.hash;
  return new Response(body, {
    headers: {
      "Content-Type": meta.mime,
      "Content-Length": String(meta.bytes),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": LOGO_CSP,
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "public, max-age=300",
    },
  });
}
