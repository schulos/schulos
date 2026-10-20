import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { compensationStatusAction, createCompensationAction, updateCompensationAction } from "@/modules/buecherei/actions";
import { MAX_COMPENSATION_REASON, compensationCandidates, listCompensations } from "@/modules/buecherei/ersatz";
import { formatEuro } from "@/modules/buecherei/labels";
import { canMaterials, lernmittelEnabled } from "@/modules/buecherei/lernmittel";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Ersatzforderungen" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));
const euroInput = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2).replace(".", ","));
const KIND_LABEL = { ausleihe: "Bücherei, Befund", schulbuch: "Schulbuch, Befund", verlust: "Schulbuch nicht zurück" } as const;

const who = (r: { name: string | null; className: string | null }) => (r.name ? `${r.name}${r.className ? ` (${r.className})` : ""}` : "Konto gelöscht");

/**
 * Ersatzforderungen (BU-12, Recht `buecherei.materials`, nur mit Schulbuchausleihe): aus Befunden und nicht zurückgegebenen
 * Schulbüchern Betrag und Grund erfassen, Brief drucken, als bezahlt oder erlassen vermerken. Keine Zahlungsabwicklung.
 */
export default async function ErsatzPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!canMaterials(perms) || !(await lernmittelEnabled(db))) notFound();
  const today = toBerlinDate(new Date());
  const [candidates, open, closed] = await Promise.all([compensationCandidates(db, perms, today), listCompensations(db, perms, { open: true }), listCompensations(db, perms, { open: false })]);
  const openSum = open.reduce((s, c) => s + c.amountCents, 0);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei · Schulbuchausleihe" title="Ersatzforderungen" />
      <BuechereiNav current="ersatz" perms={perms} />
      <p className="text-sm text-muted">
        {open.length} offen{open.length > 0 && ` · zusammen ${formatEuro(openSum)}`} · {candidates.length} zu klären. SchulOS wickelt keine Zahlungen ab – hier steht nur, was
        gefordert, bezahlt oder erlassen ist.
      </p>

      <Card aria-labelledby="zu-klaeren">
        <CardHeader title={<span id="zu-klaeren">Zu klären</span>} />
        <p className="text-sm text-muted">Befunde aus Rückgaben und Schulbücher, deren Rückgabefrist abgelaufen ist. Beim Verlust wird das Schulbuch mit der Forderung ausgesondert.</p>
        {candidates.length === 0 ? (
          <EmptyState title="Nichts zu klären" />
        ) : (
          <ul aria-label="Zu klären" className="flex flex-col divide-y divide-border">
            {candidates.map((c) => (
              <li key={`${c.kind}-${c.id}`} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{c.item}</span>
                  <Badge tone={c.kind === "verlust" ? "warn" : "soft"}>{KIND_LABEL[c.kind]}</Badge>
                  <span className="text-muted">
                    {who(c)} · seit {day(c.since)}
                  </span>
                </div>
                <SpecForm
                  action={createCompensationAction.bind(null, c.kind, c.id)}
                  label={`Ersatz fordern: ${c.item}`}
                  submit="Ersatz fordern"
                  variant="secondary"
                  fields={[
                    { name: "amount", label: "Betrag (€)", type: "text", required: true, maxLength: 10, defaultValue: euroInput(c.suggestedCents), placeholder: "z. B. 24,50" },
                    { name: "reason", label: "Grund", type: "text", required: true, maxLength: MAX_COMPENSATION_REASON, defaultValue: c.reason, hint: "nur die Sache, keine Namen" },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card aria-labelledby="offen">
        <CardHeader title={<span id="offen">Offene Forderungen</span>} />
        {open.length === 0 ? (
          <EmptyState title="Keine offenen Forderungen" />
        ) : (
          <ul aria-label="Offene Forderungen" className="flex flex-col divide-y divide-border">
            {open.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{c.item}</span>
                  <span className="tabular-nums font-semibold">{formatEuro(c.amountCents)}</span>
                  <span className="text-muted">
                    {who(c)} · {c.reason} · seit {day(c.createdOn)}
                    {c.letterOn && ` · Brief vom ${day(c.letterOn)}`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {c.userId && (
                    <Button asChild size="sm" variant="secondary">
                      {/* GATE BU2 (G-BU2-01): kein Vorabladen – das Öffnen vermerkt „Brief gedruckt am“ und schreibt ins Audit-Log */}
                      <Link href={`/druck/buecherei-ersatz?id=${encodeURIComponent(c.id)}`} prefetch={false}>
                        Brief drucken
                      </Link>
                    </Button>
                  )}
                  <form action={compensationStatusAction.bind(null, c.id, "bezahlt")}>
                    <Button type="submit" size="sm" variant="ghost" aria-label={`${c.item}: bezahlt`}>
                      bezahlt
                    </Button>
                  </form>
                  <form action={compensationStatusAction.bind(null, c.id, "erlassen")}>
                    <Button type="submit" size="sm" variant="ghost" aria-label={`${c.item}: erlassen`}>
                      erlassen
                    </Button>
                  </form>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted">Betrag oder Grund ändern</summary>
                  <SpecForm
                    action={updateCompensationAction.bind(null, c.id)}
                    label={`Forderung ändern: ${c.item}`}
                    submit="Speichern"
                    variant="secondary"
                    fields={[
                      { name: "amount", label: "Betrag (€)", type: "text", required: true, maxLength: 10, defaultValue: euroInput(c.amountCents) },
                      { name: "reason", label: "Grund", type: "text", required: true, maxLength: MAX_COMPENSATION_REASON, defaultValue: c.reason },
                    ]}
                  />
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card aria-labelledby="erledigt">
        <CardHeader title={<span id="erledigt">Abgeschlossen</span>} />
        {closed.length === 0 ? (
          <EmptyState title="Noch nichts abgeschlossen" />
        ) : (
          <Table>
            <caption className="sr-only">Abgeschlossene Forderungen</caption>
            <thead>
              <tr>
                <th>Gegenstand</th>
                <th>Person</th>
                <th className="text-right">Betrag</th>
                <th>Stand</th>
                <th className="sr-only">Wieder öffnen</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((c) => (
                <tr key={c.id}>
                  <td>{c.item}</td>
                  <td>{who(c)}</td>
                  <td className="text-right tabular-nums">{formatEuro(c.amountCents)}</td>
                  <td>
                    <Badge tone={c.status === "bezahlt" ? "success" : "neutral"}>{c.status}</Badge> {c.closedOn && <span className="text-xs text-muted">{day(c.closedOn)}</span>}
                  </td>
                  <td className="text-right">
                    <form action={compensationStatusAction.bind(null, c.id, "offen")}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`${c.item}: wieder öffnen`}>
                        wieder öffnen
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
