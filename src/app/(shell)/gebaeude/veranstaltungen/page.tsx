import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canConfigure } from "@/modules/gebaeude/pruefungen";
import { canReport, canViewAll } from "@/modules/gebaeude/service";
import { canSeeAllEvents, canUseEvents, dayHeading, eventOverview, myEvents } from "@/modules/gebaeude/veranstaltungen";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { GebaeudeNav } from "../ui";
import { EventList } from "./ui";

export const metadata: Metadata = { title: "Veranstaltungen" };

/**
 * Veranstaltungen (VA-02): Lehrkräfte und Personal sehen ihre eigenen Anmeldungen; Hausmeisterei, Verwaltung und Schulleitung die
 * offenen Anmeldungen, die Wochenvorschau (heute + 6 Tage), spätere bestätigte und die abgeschlossenen der letzten 30 Tage.
 */
export default async function VeranstaltungenPage({ searchParams }: { searchParams: Promise<{ ansicht?: string }> }) {
  const { perms } = await requireUser();
  if (!canUseEvents(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const now = new Date();
  const report = canReport(perms);
  const anmelden = report ? (
    <Button asChild variant="primary">
      <Link href="/gebaeude/veranstaltungen/neu">Veranstaltung anmelden</Link>
    </Button>
  ) : null;

  if (!canSeeAllEvents(perms) || sp.ansicht === "meine") {
    const own = await myEvents(db, perms, now);
    const running = own.filter((e) => e.teardownAt > now && e.status !== "abgelehnt" && e.status !== "abgesagt");
    const done = own.filter((e) => !running.includes(e));
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Gebäude & Technik" title="Meine Veranstaltungen" actions={anmelden} />
        {canSeeAllEvents(perms) && (
          <Link href="/gebaeude/veranstaltungen" className="text-sm font-medium text-accent-ink hover:underline">
            Zur Übersicht aller Veranstaltungen
          </Link>
        )}
        <section aria-labelledby="kommend" className="flex flex-col gap-3">
          <h2 id="kommend" className="font-display text-xl font-bold">
            Angemeldet {running.length > 0 && <Badge tone="count">{running.length}</Badge>}
          </h2>
          {running.length === 0 ? (
            <EmptyState title="Keine Veranstaltung angemeldet">Elternabend in der Aula, Sportfest, Theater? Über „Veranstaltung anmelden“ erfährt die Hausmeisterei rechtzeitig von Aufbau, Räumen und Schließzeiten.</EmptyState>
          ) : (
            <EventList items={running} label="Meine angemeldeten Veranstaltungen" />
          )}
        </section>
        {done.length > 0 && (
          <section aria-labelledby="vorbei" className="flex flex-col gap-3">
            <h2 id="vorbei" className="font-display text-xl font-bold">
              Vorbei, abgelehnt oder abgesagt (30 Tage)
            </h2>
            <EventList items={done} label="Meine vergangenen Veranstaltungen" />
          </section>
        )}
      </main>
    );
  }

  const o = await eventOverview(db, perms, now);
  const today = o.week[0]?.date;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Gebäude & Technik"
        title="Veranstaltungen"
        actions={
          <>
            {report && (
              <Button asChild>
                <Link href="/gebaeude/veranstaltungen?ansicht=meine">Meine Veranstaltungen</Link>
              </Button>
            )}
            {anmelden}
          </>
        }
      />
      {/* Schulleitung mit Freigabe-Recht, aber ohne „alles lesen“: die übrigen Bereiche wären für sie 404 */}
      {canViewAll(perms) && <GebaeudeNav current="veranstaltungen" configure={canConfigure(perms)} />}
      {o.approval.length > 0 && (
        <section aria-labelledby="freigabe" className="flex flex-col gap-3">
          <h2 id="freigabe" className="font-display text-xl font-bold">
            Wartet auf Freigabe <Badge tone="count">{o.approval.length}</Badge>
          </h2>
          <EventList items={o.approval} label="Veranstaltungen zur Freigabe" showOrganizer />
        </section>
      )}
      <section aria-labelledby="offen" className="flex flex-col gap-3">
        <h2 id="offen" className="font-display text-xl font-bold">
          Zu bestätigen {o.open.length > 0 && <Badge tone="count">{o.open.length}</Badge>}
        </h2>
        {o.open.length === 0 ? <EmptyState title="Keine offenen Anmeldungen" /> : <EventList items={o.open} label="Offene Anmeldungen" showOrganizer />}
      </section>
      <section aria-labelledby="woche" className="flex flex-col gap-3">
        <h2 id="woche" className="font-display text-xl font-bold">
          Wochenvorschau
        </h2>
        <ol aria-label="Wochenvorschau" className="flex flex-col gap-3">
          {o.week.map((d) => (
            <li key={d.date} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                {d.date === today ? `Heute, ${dayHeading(d.date)}` : dayHeading(d.date)}
              </h3>
              {d.events.length === 0 ? <p className="text-sm text-muted">nichts angemeldet</p> : <EventList items={d.events} label={`Veranstaltungen ${dayHeading(d.date)}`} />}
            </li>
          ))}
        </ol>
      </section>
      {o.later.length > 0 && (
        <section aria-labelledby="spaeter" className="flex flex-col gap-3">
          <h2 id="spaeter" className="font-display text-xl font-bold">
            Später (bestätigt)
          </h2>
          <EventList items={o.later} label="Spätere Veranstaltungen" showOrganizer />
        </section>
      )}
      {o.past.length > 0 && (
        <section aria-labelledby="vorbei" className="flex flex-col gap-3">
          <h2 id="vorbei" className="font-display text-xl font-bold">
            Vorbei, abgelehnt oder abgesagt (30 Tage)
          </h2>
          <EventList items={o.past} label="Abgeschlossene Veranstaltungen" showOrganizer />
        </section>
      )}
    </main>
  );
}
