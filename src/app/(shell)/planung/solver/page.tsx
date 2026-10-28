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
import { DEFAULT_PASSES, EFFORT_LABELS, listRunSummaries, MODE_LABELS, PASS_CHOICES, PRESET_LABELS, SCOPE_LABELS, WEIGHT_PRESETS, type RunSummary } from "@/modules/stundenplan/solverlauf";
import { isComparable, MAX_COMPARE, MIN_COMPARE } from "@/modules/stundenplan/solververgleich";
import { yearOfVersion } from "@/modules/stundenplan/planungsjahr";
import { QUELLE_LIVE, resolveQuelle } from "@/modules/stundenplan/quelle";
import { planningYearForPage } from "../planungsjahr";
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
  searchParams: Promise<{ lauf?: string; gruppe?: string; fehler?: string; geloescht?: string; status?: string; quelle?: string; jahr?: string }>;
}) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  // alte Links (Übersicht, Lesezeichen) mit ?lauf= → Detailseite
  if (sp.lauf) redirect(`/planung/solver/${encodeURIComponent(sp.lauf)}${sp.gruppe ? `?vorschau=g:${encodeURIComponent(sp.gruppe)}` : ""}`);
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const filter = STATUS_FILTERS.find((f) => f.key === (sp.status ?? "")) ?? STATUS_FILTERS[0]!;
  // SP3-09b: im gewählten Planungsjahr (ein Entwurf in ?quelle= stellt auf sein Jahr um); im Folgejahr nur im Entwurf, abgeschlossene nur lesbar
  const draftYear = sp.quelle && sp.quelle !== QUELLE_LIVE ? ((await yearOfVersion(db, sp.quelle))?.id ?? null) : null;
  const py = await planningYearForPage(db, "/planung/solver", sp, draftYear);
  const year = py?.year ?? null;
  const isBase = py?.isBase ?? true;
  const writable = py?.writable ?? false;
  // laufende Läufe aller Schuljahre: es rechnet immer nur einer (auch einer im anderen Jahr hält den neuen auf)
  const [runs, active, activeAll, fixedCount] = await Promise.all([
    year ? listRunSummaries(db, { schoolYearId: year.id, status: filter.statuses ?? undefined, limit: HISTORY_LIMIT }) : Promise.resolve([] as RunSummary[]),
    year ? listRunSummaries(db, { schoolYearId: year.id, status: ["queued", "running"] }) : Promise.resolve([] as RunSummary[]),
    listRunSummaries(db, { status: ["queued", "running"] }),
    db.$count(timetableLessons, eq(timetableLessons.fixed, true)),
  ]);
  const [latest] = year ? await listRunSummaries(db, { schoolYearId: year.id, limit: 1 }) : [];
  // SP3-02: im Entwurf rechnen (Vorauswahl über ?quelle=, z. B. aus der Pflege-Seite)
  const q = await resolveQuelle(db, sp.quelle, year?.id ?? null);
  // SP3-09b: außerhalb des laufenden Schuljahrs gibt es keinen gültigen Plan zum Rechnen – nur Entwürfe, Vorgabe der neueste
  const sources = (isBase ? q.options : q.options.filter((o) => o.value !== QUELLE_LIVE)).map((o) => ({ value: o.value, label: o.label }));
  const defaultSource = isBase || q.version ? q.value : (sources[0]?.value ?? QUELLE_LIVE);
  const canStart = writable && sources.length > 0;
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
        Zeitwünsche, Hohlstunden, Fach mehrfach am Tag, Raumwünsche und späte Stunden. Fixierte Stunden{isBase ? ` (${fixedCount})` : ""} und Stunden ohne
        Lehrauftrag bleiben, wo sie sind. Jeder Lauf speichert seine Parameter und rechnet gegen den gültigen Plan oder einen Entwurf; „Übernehmen“ auf der
        Seite eines Laufs füllt einen Entwurf – der gültige Plan ändert sich erst, wenn der Entwurf veröffentlicht wird.
        {year && !isBase && writable && ` Im Schuljahr ${year.name} rechnet der Solver nur in einem Entwurf dieses Jahrs – mit dessen Lehraufträgen, Zeitwünschen und Tagesregeln; das laufende Schuljahr bleibt unverändert.`}
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

      {year && canStart ? (
        <Card aria-labelledby="start-title">
          <h2 id="start-title" className="text-base font-semibold">
            Neuer Lauf
          </h2>
          <SolverStartForm
            action={startSolverAction.bind(null, year.id)}
            presets={WEIGHT_PRESETS}
            presetLabels={PRESET_LABELS}
            efforts={EFFORT_LABELS}
            defaultSeed={Math.min(999_999, (latest?.seed ?? 0) + 1)}
            busy={activeAll.length > 0}
            sources={sources}
            defaultSource={defaultSource}
            liveSource={QUELLE_LIVE}
            modes={MODE_LABELS}
            scopes={SCOPE_LABELS}
            passChoices={PASS_CHOICES}
            defaultPasses={DEFAULT_PASSES}
          />
        </Card>
      ) : year && writable ? (
        <EmptyState title={`Noch kein Entwurf für ${year.name}`}>
          Im Folgejahr rechnet die automatische Planung in einem Entwurf: unter{" "}
          <Link href="/planung/versionen#vorlagen" className="font-medium text-accent-ink underline">
            Planversionen
          </Link>{" "}
          mit der Vorlage „Neues Schuljahr“ anlegen.
        </EmptyState>
      ) : year ? (
        <p role="status" className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
          Das Schuljahr {year.name} ist abgeschlossen – die Läufe sind nur noch lesbar.
        </p>
      ) : (
        <EmptyState title="Kein Schuljahr angelegt">Zuerst unter Verwaltung → Stammdaten ein Schuljahr anlegen.</EmptyState>
      )}

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
                      {r.params ? `${r.params.mode === "entwurf" ? "ab Entwurf · " : ""}${r.params.passes ? `${r.params.passes} Durchgänge · ` : ""}${EFFORT_LABELS[r.params.effort]} · ${PRESET_LABELS[r.params.preset]}` : "–"}
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
