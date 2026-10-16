import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { periods } from "@/core/db/schema";
import { TZ, toBerlinDate } from "@/core/time";
import { addPhotosAction, assignAction, blockRoomAction, changeStatusAction, commentAction, endBlockAction } from "@/modules/gebaeude/actions";
import { CATEGORY_LABELS, MAX_PHOTOS, PRIORITY_LABELS, STATUS_LABELS, isClosed, placeLabel } from "@/modules/gebaeude/labels";
import { assigneeOptions, getTicket, ticketBlock } from "@/modules/gebaeude/service";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { PriorityBadge, StatusBadge } from "../ui";
import { AssignForm, BlockForm, CommentForm, PhotoForm, StatusForm } from "./forms";

export const metadata: Metadata = { title: "Meldung" };

const when = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ gemeldet?: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const { id } = await params;
  const detail = await getTicket(db, perms, id);
  if (!detail) notFound();
  const { ticket: t, photos, events, manage } = detail;
  const today = toBerlinDate(new Date());
  const [block, assignees, ps] = await Promise.all([
    ticketBlock(db, perms, t.roomBlockId, today),
    manage ? assigneeOptions(db) : Promise.resolve([]),
    manage ? db.select({ nr: periods.nr }).from(periods).orderBy(asc(periods.nr)) : Promise.resolve([]),
  ]);
  const justReported = (await searchParams).gemeldet === "1";

  return (
    <main className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        eyebrow={`Gebäude & Technik · ${t.number}`}
        title={t.title}
        actions={
          <Link href="/gebaeude" className="text-sm font-medium text-accent-ink hover:underline">
            Zur Übersicht
          </Link>
        }
      />
      {justReported && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Gemeldet – die Zuständigen sind benachrichtigt. Du bekommst einen Gong, wenn sich etwas tut.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card aria-labelledby="angaben" className="lg:col-span-2">
          <h2 id="angaben" className="sr-only">
            Angaben
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            <span className="text-sm text-muted">
              {CATEGORY_LABELS[t.category]} · Priorität {PRIORITY_LABELS[t.priority]}
            </span>
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Ort</dt>
              <dd className="font-medium">
                {placeLabel(t)}
                {t.roomName && t.roomName !== t.roomId && t.roomName !== `Raum ${t.roomId}` && <span className="font-normal text-muted"> · {t.roomName}</span>}
                {(t.building || t.floor) && <span className="block text-xs font-normal text-muted">{[t.building, t.floor].filter(Boolean).join(", ")}</span>}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Gemeldet</dt>
              <dd>
                {when.format(t.createdAt)}
                {t.reporterName && ` von ${t.reporterName}`}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Bearbeitet von</dt>
              <dd>{t.assigneeName ?? "noch niemand"}</dd>
            </div>
            {t.closedAt && (
              <div>
                <dt className="text-muted">Abgeschlossen</dt>
                <dd>{when.format(t.closedAt)}</dd>
              </div>
            )}
          </dl>
          {t.description && <p className="whitespace-pre-line">{t.description}</p>}
          {photos.length > 0 && (
            <ul aria-label="Fotos" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photos.map((p, i) => (
                <li key={p.id}>
                  <a href={`/api/gebaeude/foto/${p.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element -- geschützte Route mit Sitzung, kein Bild-Optimierer */}
                    <img src={`/api/gebaeude/foto/${p.id}`} alt={`Foto ${i + 1} zur Meldung`} className="aspect-[4/3] w-full bg-surface-2 object-cover" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {detail.canAddPhotos && <PhotoForm action={addPhotosAction.bind(null, t.id)} left={MAX_PHOTOS - photos.length} />}
        </Card>

        <div className="flex flex-col gap-4">
          {manage && detail.transitions.length > 0 && (
            <Card aria-labelledby="bearbeiten">
              <CardHeader title={<span id="bearbeiten">Bearbeiten</span>} />
              <StatusForm action={changeStatusAction.bind(null, t.id)} transitions={detail.transitions} hasBlock={Boolean(block?.active)} />
              <AssignForm action={assignAction.bind(null, t.id)} options={assignees.map((a) => ({ value: a.id, label: a.name }))} current={t.assigneeId} />
            </Card>
          )}
          {(t.roomId && manage) || block ? (
            <Card aria-labelledby="raumsperre">
              <CardHeader title={<span id="raumsperre">Raumsperre</span>} />
              {block ? (
                <div className="flex flex-col gap-2 text-sm">
                  <p>
                    Raum {block.block.roomId} {block.active ? "gesperrt" : "war gesperrt"}: <span className="font-medium">{block.span}</span>
                  </p>
                  {block.active && hasPermission(perms, "stundenplan.manage") && (
                    <Link href="/stundenplan/raeume?ansicht=sperrungen" className="font-medium text-accent-ink hover:underline">
                      Betroffene Stunden und Ausweichräume
                    </Link>
                  )}
                  {manage && block.active && block.bookings.length > 0 && (
                    <div role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-warn">
                      Im Sperrzeitraum gebucht – bitte Bescheid geben:
                      <ul className="mt-1 list-disc pl-5">
                        {block.bookings.map((b) => (
                          <li key={`${b.date}-${b.periodNr}`}>
                            {dayFmt.format(new Date(`${b.date}T12:00:00Z`))}, {b.periodNr}. Std.{b.byName && ` – ${b.byName}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {manage && block.active && (
                    <form action={endBlockAction.bind(null, t.id)}>
                      <Button type="submit" size="sm">
                        Sperre beenden
                      </Button>
                    </form>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted">Raum ist nicht gesperrt. Eine Sperre zeigt die betroffenen Stunden im Stundenplan als Vertretungsbedarf.</p>
              )}
              {manage && t.roomId && !block?.active && !isClosed(t.status) && (
                <BlockForm action={blockRoomAction.bind(null, t.id)} today={today} roomId={t.roomId} periods={ps.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde` }))} />
              )}
            </Card>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="verlauf" className="flex flex-col gap-3">
        <h2 id="verlauf" className="font-display text-xl font-bold">
          Verlauf
        </h2>
        <ol aria-label="Verlauf" className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm">
              <span className="text-xs text-muted">
                {when.format(e.at)}
                {e.actorName && ` · ${e.actorName}`}
              </span>
              <p>
                {e.kind === "status"
                  ? e.statusFrom
                    ? `Status: ${STATUS_LABELS[e.statusFrom]} → ${STATUS_LABELS[e.statusTo!]}`
                    : "gemeldet"
                  : e.kind === "kommentar"
                    ? null
                    : e.text}
                {e.kind === "status" && e.text && <span className="block">{e.text}</span>}
                {e.kind === "kommentar" && <span className="whitespace-pre-line">{e.text}</span>}
              </p>
            </li>
          ))}
        </ol>
        {detail.canComment && <CommentForm action={commentAction.bind(null, t.id)} />}
      </section>
    </main>
  );
}
