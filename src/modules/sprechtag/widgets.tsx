import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { OFFER, STATE_LABEL, bookingStudents, eventState, familyAppointments, formatEventDay, getAvailability, nextEvent, teacherAppointments } from "./service";
import { roomLabel, slotEnd } from "./slots";

/** So weit im Voraus erscheint das Widget (Buchung läuft meist zwei bis drei Wochen vorher). */
export const WIDGET_DAYS = 28;

/**
 * „Mein Sprechtag“ (P4-53): der nächste Sprechtag mit den eigenen Terminen – für Lehrkräfte (Freigabe, Termine) und für
 * Familien bzw. eigenständige Schüler:innen (gebuchte Termine oder „Termine buchen“). Ohne Sprechtag in Sicht: nichts.
 */
async function MeinSprechtag({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const e = await nextEvent(db, today);
  if (!e || e.date > addDays(today, WIDGET_DAYS)) return null;
  const state = eventState(e, today);
  const teacher = hasPermission(current.perms, OFFER) && current.perms.role === "lehrkraft";
  const family = !teacher && (await bookingStudents(db, current.perms)).length > 0;
  if (!teacher && !family) return null;
  const appts = teacher ? await teacherAppointments(db, current.perms, e.id, current.perms.userId) : await familyAppointments(db, current.perms, e.id);
  const released = teacher ? Boolean(await getAvailability(db, e.id, current.perms.userId)) : true;
  const href = teacher ? `/sprechtag/${e.id}` : `/sprechtag/buchen?e=${e.id}`;
  return (
    <Card aria-label="Mein Sprechtag">
      <CardHeader title="Mein Sprechtag" action={{ href, label: teacher ? "Zum Plan" : state === "buchung" ? "Termine buchen" : "Zu den Terminen" }} />
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        {e.title} · {formatEventDay(e.date)} <Badge tone={state === "buchung" ? "success" : "soft"}>{STATE_LABEL[state]}</Badge>
      </p>
      {teacher && !released ? (
        <Link href={href} className="text-sm font-semibold text-warn hover:underline">
          Eigene Zeiten noch nicht freigegeben
        </Link>
      ) : appts.length === 0 ? (
        <p className="text-sm text-muted">{teacher ? "Noch keine Termine gebucht." : state === "buchung" ? "Noch keine Termine gebucht – jetzt buchen." : "Keine Termine gebucht."}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {appts.slice(0, 8).map((a) => (
            <li key={a.id} className="flex items-baseline gap-3 text-sm">
              <span className="w-24 shrink-0 font-semibold tabular-nums">
                {a.slot}–{slotEnd(a.slot, e.slotMinutes)}
              </span>
              <span className="min-w-0 truncate">
                {teacher ? `${a.studentName}${a.className ? ` (${a.className})` : ""}` : `${a.teacherName}${a.roomName ? ` · ${roomLabel(a.roomName)}` : ""}`}
              </span>
            </li>
          ))}
          {appts.length > 8 && <li className="text-xs text-muted">und {appts.length - 8} weitere</li>}
        </ul>
      )}
    </Card>
  );
}

export const sprechtagWidgets: WidgetDef[] = [{ id: "sprechtag.mein", moduleId: "sprechtag", order: 45, roles: ["lehrkraft", "eltern", "schueler"], Component: MeinSprechtag }];
