import { getDb } from "@/core/db/client";
import { moduleOffResponse } from "@/core/modules/guard";
import { publicIp } from "@/core/public-action";
import { readSchoolSettings } from "@/core/settings";
import { buildIcs } from "@/modules/kalender/ics";
import { loadVorgang } from "@/modules/anmeldung/public";

export const dynamic = "force-dynamic";

/** Gesprächstermin als Kalendereintrag (P4-34) – über den geheimen Vorgangslink, ohne Namen. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const off = await moduleOffResponse("anmeldung");
  if (off) return off;
  const { token } = await params;
  const db = await getDb();
  const r = await loadVorgang(db, decodeURIComponent(token), { ip: await publicIp(), now: new Date() });
  if (r.state === "limited") return new Response("Zu viele Anfragen", { status: 429, headers: { "cache-control": "no-store" } });
  if (r.state !== "ok" || !r.value.slot || !r.value.open) return new Response("Nicht gefunden", { status: 404, headers: { "cache-control": "no-store" } });
  const v = r.value;
  const school = (await readSchoolSettings(db)).name;
  const ics = buildIcs(school, [
    {
      id: `anmeldung-${v.antragId}`,
      title: `Anmeldegespräch ${school}`,
      description: `Vorgangsnummer ${v.number}. Bitte die Unterlagen im Original mitbringen.`,
      location: v.slot!.room ? `${school}, ${v.slot!.room}` : school,
      startsAt: v.slot!.startsAt,
      endsAt: v.slot!.endsAt,
      allDay: false,
      repeatWeeklyUntil: null,
      createdAt: new Date(),
    },
  ]);
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="anmeldegespraech.ics"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
