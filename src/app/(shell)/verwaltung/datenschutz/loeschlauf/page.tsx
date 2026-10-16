import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { createHoldAction, endHoldAction, runDeletionAction } from "@/core/privacy/actions";
import { planAccountDeletion } from "@/core/privacy/konto";
import { activeHolds, CLASS_LABEL, listRuns, planDeletion } from "@/core/privacy/loeschlauf";
import { ROLE_LABELS } from "@/core/labels";
import { TZ, addDays, toBerlinDate } from "@/core/time";
import { plannableGroups } from "@/modules/stundenplan/manage";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { HoldForm } from "./hold-form";

export const metadata: Metadata = { title: "Löschlauf" };

const timeFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });

/** Löschlauf: Vorschau, Ausführen, Löschprotokoll und Löschsperren (Schulleitung/Admin). */
export default async function LoeschlaufPage({ searchParams }: { searchParams: Promise<{ fehler?: string; geloescht?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.privacy")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [plan, holds, runs, groupList] = await Promise.all([planDeletion(db, today), activeHolds(db, today), listRuns(db, 10), plannableGroups(db)]);
  const accounts = await planAccountDeletion(
    db,
    today,
    holds.map((h) => h.userId).filter((x): x is string => Boolean(x)),
  );
  const due = plan.filter((p) => p.status === "due" && p.count > 0);
  const total = due.reduce((s, p) => s + p.count, 0);
  const skipped = plan.filter((p) => p.status === "skipped");

  return (
    <main className="flex flex-col gap-7">
      <Link href="/verwaltung/datenschutz" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Löschkonzept
      </Link>
      <PageHeader eyebrow="Datenschutz" title="Löschlauf" />
      <p className="-mt-4 max-w-3xl text-sm text-muted">
        Der Löschlauf löscht, was nach dem Löschkonzept fällig ist. Er läuft künftig jede Nacht; hier lässt er sich vorab prüfen und von Hand auslösen. Das
        Protokoll enthält nur Anzahlen, keine Inhalte. Löschsperren nehmen Personen oder Gruppen begründet und befristet aus.
      </p>
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {sp.geloescht !== undefined && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Löschlauf ausgeführt: {sp.geloescht} Datensätze gelöscht.
        </p>
      )}

      <section aria-labelledby="preview-title" className="flex flex-col gap-3">
        <h2 id="preview-title" className="flex flex-wrap items-center gap-2 font-display text-xl font-bold">
          Vorschau für heute
          <Badge tone={total ? "warn" : "success"}>{total ? `${total} Datensätze fällig` : "nichts fällig"}</Badge>
        </h2>
        {due.length > 0 && (
          <Table>
            <caption className="sr-only">Fällige Datensätze</caption>
            <thead>
              <tr>
                <th>Datenart</th>
                <th>Löschklasse</th>
                <th className="text-right">fällig</th>
              </tr>
            </thead>
            <tbody>
              {due.map((p) => (
                <tr key={`${p.table}-${p.scope ?? ""}`}>
                  <td>
                    {p.purpose}
                    {p.scope && <span className="text-muted"> · {p.scope}</span>}
                    <code className="block text-xs text-muted">{p.table}</code>
                  </td>
                  <td>{CLASS_LABEL(p.classId)}</td>
                  <td className="text-right tabular-nums">{p.count}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <form action={runDeletionAction} aria-label="Löschlauf ausführen" className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" value="1" className="size-4 accent-[var(--accent)]" /> Vorschau geprüft
          </label>
          <Button type="submit" variant="primary" disabled={!total}>
            Löschlauf jetzt ausführen
          </Button>
        </form>
        {skipped.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">Nicht vom Löschlauf erfasst ({skipped.length})</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {skipped.map((p) => (
                <li key={`${p.table}-${p.scope ?? ""}`}>
                  {p.purpose}
                  {p.scope && <span className="text-muted"> · {p.scope}</span>} – <span className="text-muted">{p.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {accounts.length > 0 && (
        <section aria-labelledby="accounts-title" className="flex flex-col gap-3">
          <h2 id="accounts-title" className="font-display text-xl font-bold">
            Konten nach Abgang
          </h2>
          <p className="-mt-1 max-w-3xl text-sm text-muted">
            Konten werden 90 Tage nach dem Abgang gelöscht, auf Antrag sofort. Verweist noch das Klassenbuch auf eine Person, bleibt das Konto gesperrt, bis die
            Akte archiviert und abgelaufen ist.
          </p>
          <Table>
            <caption className="sr-only">Konten nach Abgang</caption>
            <thead>
              <tr>
                <th>Person</th>
                <th>Abgang</th>
                <th>fällig seit</th>
                <th>Stand</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/verwaltung/benutzer/${encodeURIComponent(a.id)}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <span className="block text-xs text-muted">{ROLE_LABELS[a.role]}</span>
                  </td>
                  <td>{dayFmt.format(new Date(`${a.leftOn}T00:00:00Z`))}</td>
                  <td>
                    {dayFmt.format(new Date(`${a.dueOn}T00:00:00Z`))}
                    {a.erasureRequested && <Badge tone="neutral">Antrag</Badge>}
                  </td>
                  <td>{a.blocked ? <span className="text-sm text-muted">{a.blocked}</span> : <Badge tone="warn">wird gelöscht</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      <section aria-labelledby="holds-title" className="flex flex-col gap-3">
        <h2 id="holds-title" className="font-display text-xl font-bold">
          Löschsperren
        </h2>
        <Card>
          <HoldForm action={createHoldAction} groups={groupList.map((g) => ({ value: g.id, label: g.name }))} until={addDays(today, 180)} />
        </Card>
        {holds.length === 0 ? (
          <p className="text-sm text-muted">Keine aktiven Sperren.</p>
        ) : (
          <Table>
            <caption className="sr-only">Aktive Löschsperren</caption>
            <thead>
              <tr>
                <th>Person/Gruppe</th>
                <th>Begründung</th>
                <th>bis</th>
                <th>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {holds.map((h) => (
                <tr key={h.id}>
                  <td className="font-medium">{h.userName ?? h.groupName}</td>
                  <td>{h.reason}</td>
                  <td>{dayFmt.format(new Date(`${h.until}T00:00:00Z`))}</td>
                  <td className="text-right">
                    <form action={endHoldAction.bind(null, h.id)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`Sperre ${h.userName ?? h.groupName} aufheben`}>
                        Aufheben
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="runs-title" className="flex flex-col gap-3">
        <h2 id="runs-title" className="font-display text-xl font-bold">
          Löschprotokoll
        </h2>
        {runs.length === 0 ? (
          <EmptyState title="Noch kein Löschlauf" />
        ) : (
          <Table>
            <caption className="sr-only">Löschprotokoll</caption>
            <thead>
              <tr>
                <th>Zeitpunkt</th>
                <th>Ausgelöst</th>
                <th className="text-right">gelöscht</th>
                <th>Einzelheiten</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const items = r.result as { table: string; scope?: string; deleted: number; error?: string }[];
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{timeFmt.format(r.startedAt)}</td>
                    <td>{r.triggeredBy ? "von Hand" : "nächtlich"}</td>
                    <td className="text-right tabular-nums">{r.total}</td>
                    <td className="text-sm">
                      {items.length === 0
                        ? "–"
                        : items.map((i) => (
                            <span key={`${i.table}-${i.scope ?? ""}`} className="block">
                              <code>{i.table}</code>: {i.deleted}
                              {i.error && <Badge tone="danger">Fehler</Badge>}
                            </span>
                          ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}
