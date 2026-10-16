import { moduleOffResponse } from "@/core/modules/guard";
import { getDb } from "@/core/db/client";
import { apiUser } from "@/core/auth/session";
import { buildIcs } from "@/modules/kalender/ics";
import { listCalendarEvents, type CalendarKey } from "@/modules/kalender/service";

export const dynamic = "force-dynamic";

/** ICS-Download eines Kalenders: /api/kalender/ics?kal=personal|school|group:<id> */
export async function GET(req: Request) {
  const off = await moduleOffResponse("kalender");
  if (off) return off;
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const key = new URL(req.url).searchParams.get("kal") ?? "personal";
  if (!/^(personal|school|group:[\w-]+)$/.test(key)) return new Response("Ungültiger Kalender", { status: 400 });
  const db = await getDb();
  const data = await listCalendarEvents(db, me.perms, key as CalendarKey);
  if (!data) return new Response("Kalender nicht gefunden", { status: 404 });
  const name = `SchulOS – ${data.calendar.label}`;
  const file = data.calendar.label.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-");
  return new Response(buildIcs(name, data.events), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="schulos-${encodeURIComponent(file)}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
