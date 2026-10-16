import type { Metadata } from "next";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { createEventAction } from "@/modules/kalender/actions";
import { writableCalendars } from "@/modules/kalender/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { EventForm } from "../event-form";

export const metadata: Metadata = { title: "Termin anlegen" };

export default async function NeuerTerminPage({ searchParams }: { searchParams: Promise<{ datum?: string }> }) {
  const { perms } = await requireUser();
  const { datum } = await searchParams;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(datum ?? "") ? datum! : toBerlinDate(new Date());
  const calendars = await writableCalendars(await getDb(), perms);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Kalender" title="Termin anlegen" />
      <Card>
        <EventForm
          action={createEventAction}
          calendars={calendars}
          submitLabel="Anlegen"
          initial={{ calendar: "personal", title: "", description: "", location: "", allDay: false, start: `${day}T10:00`, end: `${day}T11:00`, repeatUntil: "" }}
        />
      </Card>
    </main>
  );
}
