import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ANTRAG_STATUS_LABELS, LOS_STATUS_LABELS, type LosStatus } from "@/modules/anmeldung/labels";
import { getLot } from "@/modules/anmeldung/los";
import { canDecide, getVerfahren } from "@/modules/anmeldung/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { dateTime, VerfahrenNav } from "../../../shared";
import { ApplyLotForm, DiscardLotForm, DrawLotForm } from "./forms";

export const metadata: Metadata = { title: "Losverfahren" };
export const dynamic = "force-dynamic";

const TONE: Record<LosStatus, "neutral" | "success" | "warn" | "soft"> = { vorbereitet: "warn", gezogen: "soft", uebernommen: "success", verworfen: "neutral" };

/**
 * LO-02: ein Lauf des Losverfahrens. Vorbereitet → Seed-Hash steht fest (vor Zeug:innen zeigen), „Los ziehen“ deckt den Seed
 * auf; danach Rangliste, Übernahme per Klick, neu losen nur mit Begründung. Lesen mit `anmeldung.view`, handeln mit `decide`.
 */
export default async function LosPage({ params }: { params: Promise<{ id: string; losId: string }> }) {
  const { perms } = await requireUser();
  const { id, losId } = await params;
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(id)).catch(() => null);
  if (!v) notFound();
  const detail = await getLot(db, perms, decodeURIComponent(losId));
  if (!detail || detail.lot.verfahrenId !== v.id) notFound();
  const { lot, rows, verify } = detail;
  const act = canDecide(perms) && v.status !== "abgeschlossen";
  const drawn = lot.order !== null;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow={`Losverfahren · ${v.name}`} title={`Lauf ${lot.seq}`} actions={<Badge tone={TONE[lot.status]}>{LOS_STATUS_LABELS[lot.status]}</Badge>} />
      <VerfahrenNav id={v.id} current="entscheidung" />
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/verwaltung/anmeldung/${v.id}/entscheidung`}>← Zur Entscheidungsliste</Link>
        </Button>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/druck/anmeldung-los/${lot.id}`}>Protokoll drucken</Link>
        </Button>
      </div>

      <Card aria-label="Losgruppe">
        <CardHeader title="Losgruppe" />
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Plätze</dt>
          <dd className="tabular-nums">
            {lot.places} von {lot.participants.length} Anträgen
          </dd>
          <dt className="text-muted">Vorbereitet</dt>
          <dd>{dateTime.format(lot.preparedAt)}</dd>
          <dt className="text-muted">Prüfwert (SHA-256 des Seeds)</dt>
          <dd className="font-mono text-xs break-all" data-testid="seed-hash">
            {lot.seedHash}
          </dd>
          {lot.seed && (
            <>
              <dt className="text-muted">Seed (aufgedeckt beim Ziehen)</dt>
              <dd className="font-mono text-xs break-all" data-testid="seed">
                {lot.seed}
              </dd>
            </>
          )}
          {lot.drawnAt && (
            <>
              <dt className="text-muted">Gezogen</dt>
              <dd>
                {dateTime.format(lot.drawnAt)}
                {lot.witnesses ? ` · Zeug:innen: ${lot.witnesses}` : ""}
              </dd>
            </>
          )}
          {lot.appliedAt && (
            <>
              <dt className="text-muted">Übernommen</dt>
              <dd>{dateTime.format(lot.appliedAt)}</dd>
            </>
          )}
          {lot.discardedAt && (
            <>
              <dt className="text-muted">Verworfen</dt>
              <dd>{dateTime.format(lot.discardedAt)}</dd>
            </>
          )}
          {lot.reason && (
            <>
              <dt className="text-muted">{lot.replacesId ? "Begründung für das Neulosen" : "Begründung"}</dt>
              <dd className="whitespace-pre-line">{lot.reason}</dd>
            </>
          )}
          {lot.replacesId && (
            <>
              <dt className="text-muted">Ersetzt</dt>
              <dd>
                <Link href={`/verwaltung/anmeldung/${v.id}/los/${lot.replacesId}`} className="inline-flex min-h-6 items-center text-accent-ink hover:underline">
                  den verworfenen Lauf
                </Link>
              </dd>
            </>
          )}
          {verify && (
            <>
              <dt className="text-muted">Nachgerechnet</dt>
              <dd data-testid="verify">{verify.hashOk && verify.orderOk ? "Seed passt zum Prüfwert, Reihenfolge stimmt" : "Abweichung – bitte melden"}</dd>
            </>
          )}
        </dl>
        {lot.status === "vorbereitet" && (
          <p role="note" className="text-sm">
            Den Prüfwert jetzt den Zeug:innen zeigen oder notieren. Er legt den Zufallswert fest, ohne ihn zu verraten – nach dem Ziehen lässt sich
            prüfen, dass genau dieser Wert benutzt wurde.
          </p>
        )}
      </Card>

      <Card aria-label={drawn ? "Ergebnis" : "Teilnehmende"}>
        <CardHeader title={drawn ? "Ergebnis (Rangliste)" : "Teilnehmende"} />
        <Table>
          <thead>
            <tr>
              {drawn && <th>Rang</th>}
              <th>Nummer</th>
              <th>Kind</th>
              {drawn && <th>Ergebnis des Loses</th>}
              <th>Stand jetzt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.number}>
                {drawn && <td className="tabular-nums">{r.outcome?.rank}</td>}
                <td className="tabular-nums">{r.number}</td>
                <td>
                  {r.child ? (
                    <Link href={`/verwaltung/anmeldung/${v.id}/antrag/${r.antragId}`} className="font-medium hover:underline">
                      {r.child}
                    </Link>
                  ) : (
                    <span className="text-muted">Antrag gelöscht</span>
                  )}
                </td>
                {drawn && <td>{r.outcome?.outcome === "aufgenommen" ? "Aufnahme" : `Warteliste, Rang ${r.outcome?.waitlistRank}`}</td>}
                <td>
                  {r.status ? ANTRAG_STATUS_LABELS[r.status] : "–"}
                  {r.status === "warteliste" && r.waitlistRank ? <span className="block text-xs text-muted tabular-nums">Rang {r.waitlistRank}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {act && lot.status === "vorbereitet" && (
        <Card aria-label="Ziehen">
          <CardHeader title="Los ziehen" />
          <DrawLotForm verfahrenId={v.id} lotId={lot.id} />
          <details className="text-sm">
            <summary className="min-h-6 cursor-pointer py-1">Falsche Gruppe? Lauf verwerfen</summary>
            <div className="mt-3">
              <DiscardLotForm verfahrenId={v.id} lotId={lot.id} drawn={false} />
            </div>
          </details>
        </Card>
      )}
      {act && lot.status === "gezogen" && (
        <>
          <Card aria-label="Übernahme">
            <CardHeader title="Ergebnis übernehmen" />
            <ApplyLotForm verfahrenId={v.id} lotId={lot.id} places={lot.places} total={lot.participants.length} />
          </Card>
          <Card aria-label="Neu losen">
            <CardHeader title="Neu losen oder verwerfen" />
            <p className="text-sm text-muted">
              Nur bei einem Fehler (z. B. falsche Gruppe oder Platzzahl). Dieser Lauf bleibt mit Seed, Reihenfolge und Begründung im Protokoll. „Neu
              losen“ bildet einen neuen Lauf mit derselben Gruppe; für eine andere Gruppe den Lauf verwerfen und in der Entscheidungsliste neu bilden.
            </p>
            <DiscardLotForm verfahrenId={v.id} lotId={lot.id} drawn />
          </Card>
        </>
      )}

      <Card aria-label="Nachrechnen">
        <CardHeader title="So lässt sich das Ergebnis nachrechnen" />
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>SHA-256 des Seeds (als Text) bilden – muss dem Prüfwert entsprechen, der vor dem Ziehen angezeigt wurde.</li>
          <li>Für jede Vorgangsnummer den Text „Seed:Nummer“ mit FNV-1a (32 Bit) hashen.</li>
          <li>Aufsteigend nach diesem Wert sortieren (bei Gleichstand nach der Nummer): das ist die Rangliste. Rang 1 bis {lot.places} werden aufgenommen.</li>
        </ol>
      </Card>
    </main>
  );
}
