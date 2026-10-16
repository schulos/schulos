import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { eq, inArray } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { timetableLessons } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { applySolverAction, startSolverAction } from "@/modules/stundenplan/actions";
import { DIAGNOSIS_LABELS } from "@/modules/stundenplan/diagnose";
import { plannableGroups, teacherOptions, WEEKDAYS } from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { COST_LABELS } from "@/modules/stundenplan/solver";
import { getRun, listRuns, proposalDiagnosis, proposedLessons } from "@/modules/stundenplan/solverlauf";
import { AutoRefresh } from "@schulos/ui/auto-refresh";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Field, Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader, Progress, SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Automatisch planen" };

const timeFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const STATUS = {
  running: { label: "rechnet", tone: "warn" },
  done: { label: "fertig", tone: "success" },
  failed: { label: "Fehler", tone: "danger" },
  applied: { label: "übernommen", tone: "soft" },
} as const;

/** Automatische Planung: Lauf starten, Fortschritt, Vorschau mit Bewertung und Diagnose, Übernahme ab Stichtag. */
export default async function SolverPage({
  searchParams,
}: {
  searchParams: Promise<{ lauf?: string; gruppe?: string; fehler?: string; uebernommen?: string }>;
}) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [runs, fixedCount, groupList, master, teachers, cal] = await Promise.all([
    listRuns(db, 5),
    db.$count(timetableLessons, eq(timetableLessons.fixed, true)),
    plannableGroups(db),
    timetableMasterData(db),
    teacherOptions(db),
    loadSchoolCalendar(db),
  ]);
  const run = sp.lauf ? await getRun(db, sp.lauf) : (runs[0] ?? null);
  const running = runs.some((r) => r.status === "running");
  const stored = run?.stored ?? null;
  // Vorschlag + Stunden, die bleiben (fixiert bzw. ohne Lehrauftrag)
  const kept = stored?.keptLessonIds.length ? await db.select().from(timetableLessons).where(inArray(timetableLessons.id, stored.keptLessonIds)) : [];
  const proposal = stored
    ? [
        ...proposedLessons(stored).map((l) => ({ ...l, kept: false })),
        ...kept.map((l) => ({
          unitId: l.id,
          groupId: l.groupId,
          subjectId: l.subjectId,
          teacherId: l.teacherId,
          roomId: l.roomId,
          weekday: l.weekday,
          periodNr: l.periodNr,
          coupled: false,
          kept: true,
        })),
      ]
    : [];
  const diag = stored && run?.status !== "failed" ? await proposalDiagnosis(db, stored) : [];
  const group = groupList.find((g) => g.id === sp.gruppe) ?? groupList.find((g) => proposal.some((l) => l.groupId === g.id));
  const subjectOf = new Map(master.subjects.map((s) => [s.id, s]));
  const teacherCode = new Map(teachers.map((t) => [t.id, t.code]));
  const defaultFrom = cal.nextSchoolDay(addDays(today, 1));
  const diagCounts = (["gaps", "subjectDay", "room"] as const).map((c) => ({ c, n: diag.filter((f) => f.category === c && f.severity !== "info").length }));

  return (
    <main className="flex flex-col gap-6">
      {running && <AutoRefresh seconds={2} />}
      <Link href="/verwaltung/stundenplan" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Stundenplan pflegen
      </Link>
      <PageHeader eyebrow="Verwaltung" title="Automatisch planen" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Der Solver setzt alle Lehraufträge der Unterrichtsverteilung neu – kollisionsfrei, mit Kopplungen, Doppelstunden und Sperrzeiten – und bewertet
        Zeitwünsche, Hohlstunden, Fach mehrfach am Tag, Raumwünsche und späte Stunden. Fixierte Stunden ({fixedCount}) und Stunden ohne Lehrauftrag bleiben, wo
        sie sind. Erst „Übernehmen“ ändert den Stundenplan.
      </p>
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {sp.uebernommen && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          {sp.uebernommen} Stunden übernommen.
        </p>
      )}

      <Card aria-labelledby="start-title">
        <h2 id="start-title" className="text-base font-semibold">
          Neuer Lauf
        </h2>
        <form action={startSolverAction} aria-label="Lauf starten" className="flex flex-wrap items-end gap-3">
          <Field label="Gründlichkeit" className="w-48">
            <Select name="effort" defaultValue="normal">
              <option value="schnell">schnell</option>
              <option value="normal">normal</option>
              <option value="gruendlich">gründlich</option>
            </Select>
          </Field>
          <Field label="Startwert" hint="anderer Wert = andere Lösung" className="w-40">
            <Input type="number" name="seed" min={1} max={99999} defaultValue={(runs[0]?.seed ?? 0) + 1} />
          </Field>
          <Button type="submit" variant="primary" disabled={running}>
            Plan berechnen
          </Button>
        </form>
      </Card>

      {runs.length > 0 && (
        <section aria-labelledby="runs-title" className="flex flex-col gap-3">
          <h2 id="runs-title" className="font-display text-xl font-bold">
            Letzte Läufe
          </h2>
          <Table>
            <caption className="sr-only">Letzte Läufe</caption>
            <thead>
              <tr>
                <th>Gestartet</th>
                <th>Status</th>
                <th className="text-right">Startwert</th>
                <th className="text-right">Bewertung</th>
                <th>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} aria-current={r.id === run?.id ? "true" : undefined}>
                  <td>{timeFmt.format(r.createdAt)}</td>
                  <td>
                    <Badge tone={STATUS[r.status].tone}>
                      {STATUS[r.status].label}
                      {r.status === "running" && ` ${r.progress} %`}
                    </Badge>
                    {r.appliedFrom && <span className="ml-2 text-sm text-muted">ab {dayFmt.format(fromBerlinLocal(r.appliedFrom))}</span>}
                  </td>
                  <td className="text-right tabular-nums">{r.seed}</td>
                  <td className="text-right tabular-nums">{r.stored ? r.stored.result.score : "–"}</td>
                  <td className="text-right">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/verwaltung/stundenplan/solver?lauf=${r.id}`}>Ansehen</Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {run?.status === "running" && (
        <Card aria-labelledby="prog-title">
          <h2 id="prog-title" className="text-base font-semibold">
            Berechnung läuft …
          </h2>
          <Progress value={run.progress} label="Fortschritt" />
          <p className="text-sm text-muted">{run.progress} % – die Seite aktualisiert sich selbst.</p>
        </Card>
      )}
      {run?.status === "failed" && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          Der Lauf ist fehlgeschlagen: {run.error}
        </p>
      )}

      {run && stored && (
        <section aria-labelledby="result-title" className="flex flex-col gap-4">
          <h2 id="result-title" className="font-display text-xl font-bold">
            Vorschlag · Bewertung {stored.result.score}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(Object.keys(COST_LABELS) as (keyof typeof COST_LABELS)[]).map((k) => (
              <div key={k} className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm">
                <span>{COST_LABELS[k]}</span>
                <Badge tone={stored.result.breakdown[k] > 0 ? "warn" : stored.result.breakdown[k] < 0 ? "success" : "neutral"}>
                  {stored.result.breakdown[k]}
                </Badge>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted">
            {stored.result.stats.units} Einheiten, {stored.result.stats.iterations} Verbesserungsschritte ({stored.result.stats.improved} Verbesserungen).
            Kleinere Bewertung = besser.
          </p>
          {stored.result.unplaced.length > 0 && (
            <div role="alert" className="flex flex-col gap-1 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              <strong>{stored.result.unplaced.length} Stunden ließen sich nicht setzen:</strong>
              {stored.result.unplaced.slice(0, 10).map((u) => (
                <span key={u.unitId}>
                  {u.label} – {u.reason}
                </span>
              ))}
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <section aria-labelledby="why-title" className="flex flex-col gap-2">
              <h3 id="why-title" className="font-semibold">
                Was die Bewertung kostet
              </h3>
              {stored.result.items.length === 0 ? (
                <p className="text-sm text-muted">Keine Abzüge.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {stored.result.items.slice(0, 12).map((i, n) => (
                    <li key={n} className="flex gap-2">
                      <Badge>{i.cost}</Badge>
                      <span className="text-muted">{COST_LABELS[i.category]}:</span> {i.text}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="diag-title" className="flex flex-col gap-2">
              <h3 id="diag-title" className="font-semibold">
                Diagnose des Vorschlags
              </h3>
              <ul className="flex flex-wrap gap-2 text-sm">
                {diagCounts.map(({ c, n }) => (
                  <li key={c}>
                    <Badge tone={n ? "warn" : "success"}>
                      {DIAGNOSIS_LABELS[c]}: {n || "in Ordnung"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section aria-labelledby="preview-title" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h3 id="preview-title" className="font-semibold">
                Vorschau {group ? `· ${group.name}` : ""}
              </h3>
              <form className="flex items-end gap-2" aria-label="Klasse für die Vorschau">
                <input type="hidden" name="lauf" value={run.id} />
                <Select name="gruppe" defaultValue={group?.id ?? ""} aria-label="Klasse oder Kurs" className="w-56">
                  {groupList.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
                <Button type="submit">Anzeigen</Button>
              </form>
            </div>
            {group && (
              <Table>
                <caption className="sr-only">Vorschlag {group.name}</caption>
                <thead>
                  <tr>
                    <th>Stunde</th>
                    {WEEKDAYS.map((d) => (
                      <th key={d}>{d}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {master.periods.map((p) => (
                    <tr key={p.nr}>
                      <td className="whitespace-nowrap">{p.nr}.</td>
                      {WEEKDAYS.map((d, wd) => (
                        <td key={d} className="min-w-28 !py-2">
                          {proposal
                            .filter((l) => l.groupId === group.id && l.weekday === wd && l.periodNr === p.nr)
                            .map((l, i) => (
                              <span key={i} className="flex items-center gap-1.5 text-sm">
                                <SubjectBar color={subjectOf.get(l.subjectId)?.color ?? "#999"} className="h-5 w-1 shrink-0" />
                                <span>
                                  <span className="font-medium">{subjectOf.get(l.subjectId)?.name ?? l.subjectId}</span>
                                  <span className="block text-xs text-muted">
                                    {[l.teacherId ? teacherCode.get(l.teacherId) : null, l.roomId, l.kept ? "bleibt" : null].filter(Boolean).join(" · ")}
                                  </span>
                                </span>
                              </span>
                            ))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>

          {run.status === "done" && (
            <Card aria-labelledby="apply-title">
              <h3 id="apply-title" className="text-base font-semibold">
                Übernehmen
              </h3>
              <p className="text-sm text-muted">
                Ab dem Stichtag gilt der Vorschlag; der bisherige Plan endet am Vortag (Klassenbuch und Vertretungen davor bleiben). Vertretungen ab dem
                Stichtag an ersetzten Stunden entfallen.
              </p>
              <form action={applySolverAction.bind(null, run.id)} aria-label="Vorschlag übernehmen" className="flex flex-wrap items-end gap-3">
                <Field label="ab Stichtag" className="w-48">
                  <Input type="date" name="from" defaultValue={defaultFrom} required />
                </Field>
                <Button type="submit" variant="primary">
                  Ab Stichtag übernehmen
                </Button>
              </form>
            </Card>
          )}
        </section>
      )}
      {!run && <EmptyState title="Noch kein Lauf">Mit „Plan berechnen“ einen Vorschlag erstellen.</EmptyState>}
    </main>
  );
}
