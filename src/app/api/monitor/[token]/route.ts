import { moduleOffResponse } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { monitorData, monitorEnabled, screenByToken } from "@/modules/monitor/service";

export const dynamic = "force-dynamic";

/** Daten für die Kiosk-Seite (lädt jede Minute nach). Ohne Login – die geheime Adresse ist der Zugang. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const off = await moduleOffResponse("monitor");
  if (off) return off;
  const db = await getDb();
  const screen = (await monitorEnabled(db)) ? await screenByToken(db, (await ctx.params).token) : null;
  if (!screen) return Response.json({ error: "gone" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json(await monitorData(db, screen), { headers: { "Cache-Control": "no-store" } });
}
