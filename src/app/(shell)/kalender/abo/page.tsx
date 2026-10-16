import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { FEED_MAX_PER_USER, listFeeds } from "@/modules/kalender/abo";
import { createFeedAction, revokeFeedAction } from "@/modules/kalender/abo-actions";
import { readableCalendars } from "@/modules/kalender/service";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { FeedForm } from "./feed-form";

export const metadata: Metadata = { title: "Kalender abonnieren" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" });

/** Q5-15: eigene Kalender per widerrufbarem Link in der Kalender-App abonnieren (nur lesend). */
export default async function KalenderAboPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const [feeds, calendars] = await Promise.all([listFeeds(db, perms), readableCalendars(db, perms)]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Kalender"
        title="Kalender abonnieren"
        actions={
          <Button asChild variant="ghost">
            <Link href="/kalender">Zurück zum Kalender</Link>
          </Button>
        }
      />
      <p className="max-w-3xl text-muted">
        Mit einem Abo-Link zeigt Ihre Kalender-App (Handy, Outlook …) die Termine eines Kalenders an und hält sie aktuell – nur lesend. Der Link
        funktioniert im Schulnetz; von außerhalb nur, wenn die Schule den Zugang von außen freigegeben hat. Die Termine gehen dabei an Ihre
        Kalender-App bzw. deren Anbieter. Links lassen sich jederzeit widerrufen; unbenutzte verfallen nach einem Jahr.
      </p>

      <Card>
        <CardHeader title="Neuer Abo-Link" />
        <FeedForm action={createFeedAction} calendars={calendars.map((c) => ({ key: c.key, label: c.label }))} disabled={feeds.length >= FEED_MAX_PER_USER} />
        {feeds.length >= FEED_MAX_PER_USER && <p className="text-sm text-muted">Höchstens {FEED_MAX_PER_USER} Abo-Links – erst einen widerrufen.</p>}
      </Card>

      <section aria-labelledby="links" className="flex flex-col gap-3">
        <h2 id="links" className="font-display text-xl font-bold">
          Meine Abo-Links
        </h2>
        {feeds.length === 0 ? (
          <EmptyState title="Noch keine Abo-Links" />
        ) : (
          <Table>
            <caption className="sr-only">Meine Abo-Links</caption>
            <thead>
              <tr>
                <th>Bezeichnung</th>
                <th>Kalender</th>
                <th>Angelegt</th>
                <th>Zuletzt genutzt</th>
                <th>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.id}>
                  <td className="font-medium">{f.label}</td>
                  <td>{f.calendarLabel ?? <span className="text-muted">nicht mehr sichtbar</span>}</td>
                  <td>{dateFmt.format(f.createdAt)}</td>
                  <td>{f.lastUsedAt ? dateFmt.format(f.lastUsedAt) : <span className="text-muted">noch nie</span>}</td>
                  <td className="text-right">
                    <form action={revokeFeedAction.bind(null, f.id)}>
                      <Button type="submit" variant="ghost" size="sm" aria-label={`Abo-Link ${f.label} widerrufen`}>
                        Widerrufen
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}
