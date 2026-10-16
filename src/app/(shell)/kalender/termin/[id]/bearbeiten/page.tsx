import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate, toBerlinLocal } from "@/core/time";
import { updateEventAction } from "@/modules/kalender/actions";
import { getEvent, writableCalendars } from "@/modules/kalender/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { EventForm } from "../../../event-form";

export const metadata: Metadata = { title: "Termin bearbeiten" };

export default async function TerminBearbeitenPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const e = await getEvent(db, perms, decodeURIComponent(id));
  if (!e?.editable) notFound();
  const calendars = await writableCalendars(db, perms);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Kalender" title="Termin bearbeiten" />
      <Card>
        <EventForm
          action={updateEventAction.bind(null, e.id)}
          calendars={calendars}
          submitLabel="Speichern"
          initial={{
            calendar: e.key,
            title: e.title,
            description: e.description ?? "",
            location: e.location ?? "",
            allDay: e.allDay,
            start: toBerlinLocal(e.startsAt),
            end: e.allDay ? `${addDays(toBerlinDate(e.endsAt), -1)}T00:00` : toBerlinLocal(e.endsAt),
            repeatUntil: e.repeatWeeklyUntil ?? "",
          }}
        />
      </Card>
    </main>
  );
}
