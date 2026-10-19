import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { cancelReservationAction, reserveAction } from "@/modules/buecherei/actions";
import { canUse, catalogTitle } from "@/modules/buecherei/katalog";
import { MEDIA_TYPE_LABELS, formatIsbn } from "@/modules/buecherei/labels";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";
import { AvailabilityBadge } from "../../ui";

export const metadata: Metadata = { title: "Titel im Katalog" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/**
 * Ein Titel im Katalog (BU-03, Recht `buecherei.use`): Angaben, Exemplare mit Standort und „ausgeliehen bis“ (ohne Person),
 * eigene Vormerkung bzw. Vormerken, wenn alle Exemplare ausgeliehen sind.
 */
export default async function KatalogTitelPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  if (!canUse(perms)) notFound();
  const { id } = await params;
  const data = await catalogTitle(await getDb(), perms, id);
  if (!data) notFound();
  const { title: t, copies, availability: a, reservation, onLoan, canReserve } = data;

  return (
    <main className="flex flex-col gap-6">
      <Link href="/buecherei/katalog" className="text-sm font-medium text-accent-ink hover:underline">
        ← Katalog
      </Link>
      <PageHeader eyebrow={`Bücherei · ${MEDIA_TYPE_LABELS[t.mediaType]}`} title={t.title} />
      <p className="text-sm text-muted">
        {[t.author, t.publisher, t.year, t.isbn ? `ISBN ${formatIsbn(t.isbn)}` : null, t.ageFrom !== null ? `ab ${t.ageFrom} Jahren` : null].filter(Boolean).join(" · ") ||
          "ohne weitere Angaben"}
      </p>
      {t.keywords && (
        <ul aria-label="Schlagwörter" className="flex flex-wrap gap-1">
          {t.keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)
            .map((k) => (
              <li key={k}>
                <Link href={`/buecherei/katalog?q=${encodeURIComponent(k)}`}>
                  <Badge tone="soft">{k}</Badge>
                </Link>
              </li>
            ))}
        </ul>
      )}

      <Card aria-labelledby="ausleihen">
        <CardHeader title={<span id="ausleihen">Ausleihen</span>} />
        <AvailabilityBadge t={a} />
        {onLoan ? (
          <p className="text-sm">
            Du hast diesen Titel gerade ausgeliehen –{" "}
            <Link href="/buecherei/meine" className="font-medium text-accent-ink hover:underline">
              Meine Ausleihen
            </Link>
            .
          </p>
        ) : reservation ? (
          <div className="flex flex-col gap-2 text-sm">
            {reservation.readyOn && reservation.holdUntil ? (
              <p className="font-medium">Liegt für dich an der Theke bereit – abholen bis {day(reservation.holdUntil)}.</p>
            ) : (
              <p>Vorgemerkt – {reservation.position === 1 ? "du bist als Nächste:r dran" : `du bist auf Platz ${reservation.position}`}. Du bekommst Bescheid, sobald ein Exemplar bereitliegt.</p>
            )}
            <SpecForm action={cancelReservationAction.bind(null, reservation.id)} label="Vormerkung löschen" submit="Vormerkung löschen" columns={1} variant="secondary" fields={[]} />
          </div>
        ) : a.shelf > 0 ? (
          <p className="text-sm">Steht im Regal – einfach mitbringen und an der Theke ausleihen.</p>
        ) : canReserve ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>Alle Exemplare sind ausgeliehen. Merk den Titel vor – sobald einer zurückkommt, wird er für dich zurückgelegt und du bekommst Bescheid.</p>
            <SpecForm action={reserveAction.bind(null, t.id)} label="Vormerken" submit="Vormerken" columns={1} fields={[]} />
          </div>
        ) : null}
      </Card>

      <Card aria-labelledby="exemplare">
        <CardHeader title={<span id="exemplare">Exemplare</span>} />
        <Table>
          <caption className="sr-only">Exemplare von {t.title}</caption>
          <thead>
            <tr>
              <th>Signatur</th>
              <th>Standort</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {copies.map((c) => (
              <tr key={c.id}>
                <td>{c.signature ?? "–"}</td>
                <td>{c.location ?? "–"}</td>
                <td>{c.dueOn ? <Badge tone="neutral">ausgeliehen bis {day(c.dueOn)}</Badge> : <Badge tone="success">im Haus</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </main>
  );
}
