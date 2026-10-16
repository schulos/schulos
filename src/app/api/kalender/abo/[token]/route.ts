import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { publicIp } from "@/core/public-action";
import { readFeed } from "@/modules/kalender/abo";

export const dynamic = "force-dynamic";

const HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
};

/**
 * Kalender-Abo (Q5-15, SICHERHEIT.md S39): ohne Sitzung, nur über den geheimen Link, nur lesend. Ungültige, widerrufene und
 * nicht mehr lesbare Kalender antworten gleich (404); von außen gelten dieselben Regeln wie für eine Anmeldung (403).
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const off = await moduleOffResponse("kalender");
  if (off) return off;
  const { token } = await params;
  const r = await readFeed(await getDb(), token, { ip: await publicIp(), headers: req.headers, now: new Date() });
  if (r.state === "limited") return new Response("Zu viele Anfragen", { status: 429, headers: { ...HEADERS, "retry-after": "900" } });
  if (r.state === "denied") return new Response(r.text, { status: 403, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });
  if (r.state !== "ok") return new Response("Nicht gefunden", { status: 404, headers: HEADERS });
  return new Response(r.ics, {
    headers: { ...HEADERS, "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="schulos.ics"' },
  });
}
