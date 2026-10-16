// JSON-Body für die Live-APIs (Texte P3-11, Tafeln P3-12) – rein (ohne Sitzung/DB), damit es sich direkt testen lässt.

const NO_STORE = { "cache-control": "private, no-store" };

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/**
 * JSON-Body lesen; zu groß → 413, kein Objekt → 400. CSRF (P311-05): nur `application/json` (ein HTML-Formular kann das nicht
 * senden) und, wenn der Browser `sec-fetch-site` mitschickt, nur von derselben Origin – SameSite=Lax allein ließe ein
 * text/plain-Formular einer Schwester-Subdomain durch.
 */
export async function readJsonBody(req: Request, maxBytes: number, tooLarge = "Die Änderung ist zu groß"): Promise<Record<string, unknown> | Response> {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ error: "Kein Zugriff" }, 403);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json({ error: "Nur JSON" }, 415);
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return json({ error: tooLarge }, 413);
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) return json({ error: tooLarge }, 413); // Bytes, nicht Zeichen (Umlaute)
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Ungültige Anfrage" }, 400);
    return body as Record<string, unknown>;
  } catch {
    return json({ error: "Ungültige Anfrage" }, 400);
  }
}
