import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Clock, MapPin, Pencil, Repeat } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate } from "@/core/time";
import { fmtDayLong, timeRange, ymdToDate } from "@/modules/kalender/format";
import { getEvent, readableCalendars } from "@/modules/kalender/service";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { DeleteEvent } from "./delete-event";

export const metadata: Metadata = { title: "Termin" };

export default async function TerminPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const e = await getEvent(db, perms, decodeURIComponent(id));
  if (!e) notFound();
  const cal = (await readableCalendars(db, perms)).find((c) => c.key === e.key);
  const firstDay = toBerlinDate(e.startsAt);
  const lastDay = e.allDay ? addDays(toBerlinDate(e.endsAt), -1) : toBerlinDate(e.endsAt);
  const days = firstDay === lastDay ? fmtDayLong.format(ymdToDate(firstDay)) : `${fmtDayLong.format(ymdToDate(firstDay))} – ${fmtDayLong.format(ymdToDate(lastDay))}`;

  return (
    <main className="flex max-w-2xl flex-col gap-5">
      <Link href={`/kalender?datum=${firstDay}`} className="inline-flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Kalender
      </Link>
      <Card className="gap-5 p-6">
        <div className="flex items-center gap-2 text-sm text-muted">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: cal?.color }} />
          {cal?.label}
        </div>
        <h1 className="font-display text-3xl font-bold tracking-tight">{e.title}</h1>
        <ul className="flex flex-col gap-2.5">
          <li className="flex items-center gap-3">
            <CalendarDays className="size-5 text-muted" aria-hidden /> {days}
          </li>
          <li className="flex items-center gap-3">
            <Clock className="size-5 text-muted" aria-hidden /> {timeRange({ allDay: e.allDay, start: e.startsAt, end: e.endsAt })}
          </li>
          {e.location && (
            <li className="flex items-center gap-3">
              <MapPin className="size-5 text-muted" aria-hidden /> {e.location}
            </li>
          )}
          {e.repeatWeeklyUntil && (
            <li className="flex items-center gap-3">
              <Repeat className="size-5 text-muted" aria-hidden /> Jede Woche bis {fmtDayLong.format(ymdToDate(e.repeatWeeklyUntil))}
            </li>
          )}
        </ul>
        {e.description && <p className="whitespace-pre-line text-muted">{e.description}</p>}
        {e.editable && (
          <footer className="flex gap-2 border-t border-border pt-4">
            <Button asChild size="sm">
              <Link href={`/kalender/termin/${e.id}/bearbeiten`}>
                <Pencil aria-hidden /> Bearbeiten
              </Link>
            </Button>
            <DeleteEvent id={e.id} recurring={!!e.repeatWeeklyUntil} />
          </footer>
        )}
      </Card>
    </main>
  );
}
