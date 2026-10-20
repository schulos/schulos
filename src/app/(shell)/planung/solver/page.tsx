import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { eq } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { timetableLessons } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { cancelSolverAction, startSolverAction } from "@/modules/stundenplan/actions";
import { EFFORT_LABELS, listRunSummaries, PRESET_LABELS, WEIGHT_PRESETS, type RunSummary } from "@/modules/stundenplan/solverlauf";
import { isComparable, MAX_COMPARE, MIN_COMPARE } from "@/modules/stundenplan/solververgleich";
import { planningYear } from "@/modules/stundenplan/verteilung";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { LiveStatusBadge, RunLiveProvider } from "./live";
import { CompareBar, CompareCheckbox, CompareProvider } from "./compare-select";
import { SolverStartForm } from "./start-form";
import { duration, num, runTitle, timeFmt } from "./format";
import { isActive, STATUS_FILTERS } from "./status";

export const metadata: Metadata = { title: "Automatisch planen" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const HISTORY_LIMIT = 100;

/** SP-07: Solver-Läufe – neuen Lauf mit Parametern starten, Historie mit Kennzahlen und Filter, Status live, Abbrechen. */
export default async function SolverPage({
  searchParams,
}: {
  searchParams: Promise<{ lauf?: string; gruppe?: string; fehler?: string; geloescht?: string; status?: string }>;
}) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  // alte Links (Übersicht, Lesezeichen) mit ?lauf= → Detailseite
  if (sp.lauf) redirect(`/planung/solver/${encodeURIComponent(sp.lauf)}${sp.gruppe ? `?vorschau=g:${encodeURIComponent(sp.gruppe)}` : ""}`);
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const filter = STATUS_FILTERS.find((f) => f.key === (sp.status ?? "")) ?? STATUS_FILTERS[0]!;
  const year = await planningYear(db);
  const [runs, active, fixedCount] = await Promise.all([
    year ? listRunSummaries(db, { schoolYearId: year.id, status: filter.statuses ?? undefined, limit: HISTORY_LIMIT }) : Promise.resolve([] as RunSummary[]),
    year ? listRunSummaries(db, { schoolYearId: year.id, status: ["queued", "running"] }) : Promise.resolve([] as RunSummary[]),
    db.$count(timetableLessons, eq(timetableLessons.fixed, true)),
  ]);
  const [latest] = year ? await listRunSummaries(db, { schoolYearId: year.id, limit: 1 }) : [];
  const liveInitial = active.map((r) => ({ id: r.id, status: r.status, progress: r.progress, cancelRequested: r.cancelRequested, heartbeatAt: r.heartbeatAt?.toISOString() ?? null, note: null }));
  const returnTo = `/planung/solver${filter.key ? `?status=${filter.key}` : ""}`;

  return (
    <main className="flex flex-col gap-6">
      <Link href="/planung/stundenplan" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Stundenplan pflegen
      </Link>
      <PageHeader eyebrow="Stundenplanung" title="Automatisch planen" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Der Solver setzt alle Lehraufträge der Unterrichtsverteilung neu – kollisionsfrei, mit Kopplungen, Doppelstunden und Sperrzeiten – und bewertet
        Zeitwünsche, Hohlstunden, Fach mehrfach am Tag, Raumwünsche und späte Stunden. Fixierte Stunden ({fixedCount}) und Stunden ohne Lehrauftrag bleiben, wo
        sie sind. Jeder Lauf speichert seine Parameter; erst „Übernehmen“ auf der Seite eines Laufs ändert den Stundenplan.
      </p>
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {sp.geloescht && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Lauf gelöscht.
        </p>
      )}

      <Card aria-labelledby="start-title">
        <h2 id="start-title" className="text-base font-semibold">
          Neuer Lauf
        </h2>
        <SolverStartForm
          action={startSolverAction}
          presets={WEIGHT_PRESETS}
          presetLabels={PRESET_LABELS}
          efforts={EFFORT_LABELS}
          defaultSeed={Math.min(999_999, (latest?.seed ?? 0) + 1)}
          busy={active.length > 0}
        />
      </Card>

      <RunLiveProvider key={liveInitial.map((r) => `${r.id}:${r.status}`).join()} initial={liveInitial}>
        <section aria-labelledby="runs-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="runs-title" className="font-display text-xl font-bold">
              Läufe {year ? `im Schuljahr ${year.name}` : ""}
            </h2>
            <nav aria-label="Läufe filtern" className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((f) => (
                <Link
                  key={f.key}
                  href={f.key ? `/planung/solver?status=${f.key}` : "/planung/solver"}
                  aria-current={f.key === filter.key ? "page" : undefined}
                  className="rounded-full border border-border px-3 py-1 text-sm text-muted hover:text-ink aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
                >
                  {f.label}
                </Link>
              ))}
            </nav>
          </div>
          {runs.length === 0 ? (
            <EmptyState title={filter.statuses ? "Keine Läufe mit diesem Status" : "Noch kein Lauf"}>
              {filter.statuses ? "Anderen Filter wählen." : "Mit „Plan berechnen“ einen Vorschlag erstellen."}
            </EmptyState>
          ) : (
            <CompareProvider max={MAX_COMPARE}>
            {runs.filter(isComparable).length >= MIN_COMPARE && <CompareBar min={MIN_COMPARE} />}
            <Table>
              <caption className="sr-only">Läufe der automatischen Planung, neueste zuerst</caption>
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Vergleichen</span>
                  </th>
                  <th>Lauf</th>
                  <th>Parameter</th>
                  <th className="text-right">Dauer</th>
                  <th className="text-right">Bewertung</th>
                  <th className="text-right">nicht gesetzt</th>
                  <th className="text-right">
                    Hohlstunden <abbr title="Lehrkräfte">L</abbr>/<abbr title="Klassen">K</abbr>
                  </th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Aktion</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="w-8 !pr-0">{isComparable(r) && <CompareCheckbox id={r.id} label={runTitle(r)} />}</td>
                    <td>
                      <Link href={`/planung/solver/${r.id}`} className="font-medium text-accent-ink underline-offset-2 hover:underline">
                        {runTitle(r)}
                      </Link>
                      <span className="block text-xs text-muted">
                        {r.label ? `${timeFmt.format(r.createdAt)} · ` : ""}
                        {r.createdByName ?? "Konto gelöscht"}
                      </span>
                    </td>
                    <td className="text-sm whitespace-nowrap">
                      {r.params ? `${EFFORT_LABELS[r.params.effort]} · ${PRESET_LABELS[r.params.preset]}` : "–"}
                      <span className="block text-xs text-muted">Startwert {r.seed}</span>
                    </td>
                    <td className="text-right tabular-nums">{r.metrics ? duration(r.metrics.durationMs) : "–"}</td>
                    <td className="text-right tabular-nums">{r.metrics ? num.format(r.metrics.score) : "–"}</td>
                    <td className="text-right tabular-nums">{r.metrics ? r.metrics.unplaced : "–"}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{r.metrics ? `${r.metrics.gaps.teacherTotal} / ${r.metrics.gaps.classTotal}` : "–"}</td>
                    <td>
                      <LiveStatusBadge id={r.id} status={r.status} />
                      {r.appliedFrom && (
                        <span className="block text-xs text-muted">
                          ab {dayFmt.format(fromBerlinLocal(r.appliedFrom))}
                          {r.status === "applied" && r.hasUndo && r.appliedFrom > today ? " · zurücknehmbar" : ""}
                        </span>
                      )}
                      {r.metrics?.cancelledAt !== undefined && <span className="block text-xs text-muted">vorzeitig bei {r.metrics.cancelledAt} %</span>}
                      {r.status === "done" && !r.hasResult && <span className="block text-xs text-muted">Ergebnis entfernt</span>}
                    </td>
                    <td className="text-right">
                      {isActive(r.status) && !r.cancelRequested && (
                        <form action={cancelSolverAction.bind(null, r.id, returnTo)} aria-label={`${runTitle(r)} abbrechen`}>
                          <Button type="submit" size="sm" variant="ghost">
                            Abbrechen
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            </CompareProvider>
          )}
          {runs.length === HISTORY_LIMIT && <p className="text-sm text-muted">Die neuesten {HISTORY_LIMIT} Läufe; ältere mit dem Filter eingrenzen.</p>}
          <p className="text-sm text-muted">
            Bewertung: kleiner ist besser. Fertige Läufe behalten ihren Vorschlag, bis das nächtliche Aufräumen ihn bei mehr als 20 Läufen entfernt (Kennzahlen
            und Protokoll bleiben); fehlgeschlagene und abgebrochene Läufe ohne Ergebnis werden nach 7 Tagen gelöscht.
          </p>
        </section>
      </RunLiveProvider>
    </main>
  );
}
