import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { classLeadView } from "@/modules/ganztag/klassenleitung";
import { EXCUSED_LABEL, MARK_LABEL, MARK_TONE } from "@/modules/ganztag/labels";
import { dateLabel } from "@/modules/ganztag/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Ganztag: Meine Klasse" };

/** GT-04: Klassenleitung – Ganztagszeilen der eigenen Klasse (fehlt/verspätet), Teilnahme an Angeboten. Kein Klassenbuch-Eintrag. */
export default async function KlassePage() {
  const { perms } = await requireUser();
  const view = await classLeadView(await getDb(), perms);
  if (!view) notFound();
  const names = view.classes.map((c) => c.name).join(", ");

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/ganztag">
          <ArrowLeft aria-hidden /> Ganztag
        </Link>
      </Button>
      <PageHeader eyebrow="Ganztag · Meine Klasse" title={names} />
      <p className="text-muted">
        Anwesenheit der Kinder Ihrer Klasse in AGs und Ganztagsangeboten in diesem Schuljahr. Bei verpflichtenden Angeboten kommt abends ein gebündelter Hinweis zu
        unentschuldigtem Fehlen – ins Klassenbuch wird nichts übertragen; das bleibt Ihre Entscheidung.
      </p>
      <p className="flex flex-wrap gap-2" role="status" aria-label="Stand der Klasse">
        <Badge tone="success">{view.totals.anwesend} anwesend</Badge>
        <Badge tone="warn">{view.totals.verspaetet} verspätet</Badge>
        <Badge tone="danger">{view.totals.fehlt} gefehlt</Badge>
        <Badge>{view.totals.unexcused} davon ohne Entschuldigung</Badge>
      </p>

      <section aria-labelledby="fehlzeiten" className="flex flex-col gap-3">
        <h2 id="fehlzeiten" className="font-display text-xl font-bold">
          Gefehlt und verspätet
        </h2>
        {view.rows.length === 0 ? (
          <EmptyState title="Nichts zu melden">In diesem Schuljahr hat in den Angeboten niemand aus der Klasse gefehlt.</EmptyState>
        ) : (
          <ul className="rounded-card border border-border bg-surface px-4" aria-label="Gefehlt und verspätet">
            {view.rows.map((r) => (
              <li key={`${r.sessionId}-${r.studentId}`} className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex flex-col leading-tight">
                  <span className="font-medium">
                    {r.studentName}
                    {view.classes.length > 1 && <span className="font-normal text-muted"> · {r.className}</span>}
                  </span>
                  <span className="text-sm text-muted">
                    {r.offer} · {dateLabel(r.date)}, {r.startsAt} Uhr
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {r.mandatory && <Badge tone="soft">Pflichtangebot</Badge>}
                  <Badge tone={MARK_TONE[r.status]}>
                    {MARK_LABEL[r.status]}
                    {r.status === "verspaetet" && r.minutesLate ? ` (${r.minutesLate} Min.)` : ""}
                  </Badge>
                  {r.status === "fehlt" && <Badge>{EXCUSED_LABEL[r.excused]}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card className="gap-3">
        <h2 className="text-lg font-semibold">Teilnahme an Angeboten</h2>
        {view.participation.length === 0 ? (
          <p className="text-sm text-muted">Niemand aus der Klasse ist in einem Angebot mit Anwesenheitsliste.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Teilnahme an Angeboten">
            {view.participation.map((p) => (
              <li key={p.studentId}>
                <span className="font-medium">{p.name}</span>: {p.offers.join(", ")}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
