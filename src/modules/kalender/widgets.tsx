import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { Card, CardHeader } from "@schulos/ui/card";
import { timeRange } from "./format";
import { examOccurrences } from "@/modules/klausurplan/service";
import { listOccurrences, schoolDayOffOccurrences } from "./service";

const wd = new Intl.DateTimeFormat("de-DE", { weekday: "short", timeZone: "Europe/Berlin" });
const dn = new Intl.DateTimeFormat("de-DE", { day: "numeric", timeZone: "Europe/Berlin" });

async function DieseWoche({ current }: { current: CurrentUser }) {
  const today = toBerlinDate(new Date());
  const db = await getDb();
  const [events, examOcc, offOcc] = await Promise.all([
    listOccurrences(db, current.perms, today, addDays(today, 7)),
    examOccurrences(db, current.perms, today, addDays(today, 7)),
    schoolDayOffOccurrences(db, today, addDays(today, 7)),
  ]);
  const occ = [...offOcc, ...events, ...examOcc]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .filter((o) => o.end > new Date())
    .slice(0, 5);
  return (
    <Card>
      <CardHeader title="Diese Woche" action={{ href: "/kalender?ansicht=agenda", label: "Kalender" }} />
      {occ.length === 0 ? (
        <p className="text-sm text-muted">Keine Termine in den nächsten 7 Tagen.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {occ.map((o) => (
            <li key={`${o.eventId}-${o.start.toISOString()}`}>
              <Link href={o.href ?? `/kalender/termin/${o.eventId}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                <span className="flex w-11 shrink-0 flex-col items-center leading-tight">
                  <span className="text-xs text-muted">{wd.format(o.start)}</span>
                  <strong className="text-lg">{dn.format(o.start)}</strong>
                </span>
                <span aria-hidden className="h-8 w-1 shrink-0 rounded-full" style={{ background: o.color }} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{o.title}</span>
                  <span className="truncate text-xs text-muted">
                    {timeRange(o)} · {o.location ?? o.calendar}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export const kalenderWidgets: WidgetDef[] = [{ id: "kalender.woche", moduleId: "kalender", order: 15, Component: DieseWoche }];
