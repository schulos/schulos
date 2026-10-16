import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { createEventAction } from "@/modules/sprechtag/actions";
import { MANAGE, OFFER, STATE_LABEL, eventState, formatEventDay, getAvailability, listEvents } from "@/modules/sprechtag/service";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { EventForm } from "./forms";

export const metadata: Metadata = { title: "Elternsprechtag" };

export default async function SprechtagPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const manage = hasPermission(perms, MANAGE);
  const offer = hasPermission(perms, OFFER);
  const events = await listEvents(db, perms, today);
  const released = offer ? new Set((await Promise.all(events.map(async (e) => ((await getAvailability(db, e.id, perms.userId)) ? e.id : null)))).filter(Boolean)) : new Set();

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Organisation" title="Elternsprechtag" />
      {manage && (
        <Card aria-labelledby="neu">
          <h2 id="neu" className="text-base font-semibold">
            Sprechtag anlegen
          </h2>
          <EventForm
            action={createEventAction}
            submitLabel="Sprechtag anlegen"
            defaults={{
              title: "Elternsprechtag",
              date: addDays(today, 21),
              startsAt: "16:00",
              endsAt: "19:00",
              slotMinutes: "10",
              breaks: "",
              bookingOpensOn: today,
              bookingClosesOn: addDays(today, 20),
            }}
          />
        </Card>
      )}
      <section aria-labelledby="liste" className="flex flex-col gap-3">
        <h2 id="liste" className="font-display text-xl font-bold">
          {manage ? "Sprechtage" : "Kommende Sprechtage"}
        </h2>
        {events.length === 0 ? (
          <EmptyState title="Kein Sprechtag geplant" />
        ) : (
          <ul className="rounded-card border border-border bg-surface px-4">
            {events.map((e) => {
              const state = eventState(e, today);
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0">
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <Link href={`/sprechtag/${e.id}`} className="font-medium hover:underline">
                      {e.title}
                    </Link>
                    <span className="text-sm text-muted">
                      {formatEventDay(e.date)} · {e.startsAt}–{e.endsAt} Uhr · {e.slotMinutes} min
                    </span>
                  </span>
                  <Badge tone={state === "buchung" ? "success" : state === "vorbei" ? "neutral" : "soft"}>{STATE_LABEL[state]}</Badge>
                  {offer && state !== "vorbei" && <Badge tone={released.has(e.id) ? "soft" : "warn"}>{released.has(e.id) ? "Zeiten freigegeben" : "Zeiten noch nicht freigegeben"}</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
