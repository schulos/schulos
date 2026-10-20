import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { inArray } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { timetableLessons, users } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { applySolverAction, cancelSolverAction } from "@/modules/stundenplan/actions";
import { DIAGNOSIS_LABELS } from "@/modules/stundenplan/diagnose";
import { plannableGroups, teacherOptions, WEEKDAYS } from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { COST_LABELS, type CostItem } from "@/modules/stundenplan/solver";
import { canDeleteRun, EFFORT_LABELS, getRun, precheckOf, PRESET_LABELS, proposedLessons, type RunLogEntry } from "@/modules/stundenplan/solverlauf";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Field, Input } from "@schulos/ui/field";
import { PageHeader, SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { DeleteRun } from "../delete-run";
import { duration, num, runTitle, timeFmt } from "../format";
import { LiveProgress, LiveStatusBadge, RunLiveProvider } from "../live";
import { isActive, WEIGHT_FIELDS } from "../status";
import { PreviewPicker } from "./preview-picker";

export const metadata: Metadata = { title: "Solver-Lauf" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const clockFmt = new Intl.DateTimeFormat("de-DE", { timeStyle: "medium", timeZone: TZ });
const COST_ITEMS_SHOWN = 25;
const COST_ITEM_LIMIT = 300;

const LOG_KIND: Record<RunLogEntry["kind"], { label: string; tone: "neutral" | "warn" | "success" | "danger" | "soft" }> = {
  queued: { label: "angelegt", tone: "neutral" },
  start: { label: "Start", tone: "soft" },
  input: { label: "Eingabe", tone: "neutral" },
  warning: { label: "Warnung", tone: "warn" },
  precheck: { label: "Vorprüfung", tone: "neutral" },
  construct: { label: "Konstruktion", tone: "neutral" },
  progress: { label: "Zwischenstand", tone: "neutral" },
  cancel: { label: "Abbruch", tone: "warn" },
  done: { label: "Ende", tone: "success" },
  error: { label: "Fehler", tone: "danger" },
  cleanup: { label: "Aufräumen", tone: "neutral" },
};

/**
 * SP-07: ein Solver-Lauf – Status/Fortschritt live, Parameter, Kennzahlen (aus `metrics`, keine Diagnose je Aufruf), Vorprüfung,
 * nicht gesetzte Einheiten mit Grund je Beteiligtem (SP-G-03), Kostenposten mit Filter, Vorschau je Klasse oder Lehrkraft
 * (erst auf Wunsch), Protokoll, Abbrechen, Löschen, Übernahme ab Stichtag.
 */
export default async function SolverRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ vorschau?: string; kategorie?: string; fehler?: string; uebernommen?: string }>;
}) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const run = await getRun(db, id);
  if (!run) notFound();
  const stored = run.stored;
  const m = run.metrics;
  const active = isActive(run.status);

  // Vorschau nur auf Wunsch (Lasttest SP-06: die Seite soll unter Last billig bleiben)
  const [kind, target] = (sp.vorschau ?? "").split(":", 2) as [string, string | undefined];
  const wantRaw = Boolean(stored && target && (kind === "g" || kind === "t"));
  const personIds = [run.createdBy, run.appliedBy].filter((x): x is string => Boolean(x));
  const [groupList, teachers, master, people, cal] = await Promise.all([
    plannableGroups(db),
    teacherOptions(db),
    stored ? timetableMasterData(db) : Promise.resolve(null),
    personIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds)) : Promise.resolve([]),
    run.status === "done" && stored ? loadSchoolCalendar(db) : Promise.resolve(null),
  ]);
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const groupName = new Map(groupList.map((g) => [g.id, g.name]));
  const teacherCode = new Map(teachers.map((t) => [t.id, t.code ?? t.name]));
  const subjectOf = new Map((master?.subjects ?? []).map((s) => [s.id, s]));
  const wantPreview = wantRaw && (kind === "g" ? groupName.has(target!) : teacherCode.has(target!));

  const kept = wantPreview && stored!.keptLessonIds.length ? await db.select().from(timetableLessons).where(inArray(timetableLessons.id, stored!.keptLessonIds)) : [];
  const proposal = wantPreview
    ? [
        ...proposedLessons(stored!).map((l) => ({ ...l, kept: false })),
        ...kept.map((l) => ({ groupId: l.groupId, subjectId: l.subjectId, teacherId: l.teacherId, roomId: l.roomId, weekday: l.weekday, periodNr: l.periodNr, kept: true })),
      ].filter((l) => (kind === "g" ? l.groupId === target : l.teacherId === target))
    : [];
  const previewName = !wantPreview ? null : kind === "g" ? (groupName.get(target!) ?? target!) : `${teacherCode.get(target!) ?? target!} (Lehrkraft)`;

  const findings = precheckOf(run.log);
  const unplaced = stored?.result.unplaced ?? [];
  const categories = Object.keys(COST_LABELS) as CostItem["category"][];
  const category = categories.find((c) => c === sp.kategorie) ?? null;
  const items = (stored?.result.items ?? []).filter((i) => !category || i.category === category);
  const countBy = new Map<string, number>();
  for (const i of stored?.result.items ?? []) countBy.set(i.category, (countBy.get(i.category) ?? 0) + 1);
  const base = `/planung/solver/${run.id}`;
  const keep = (extra: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const merged = { vorschau: sp.vorschau ?? null, kategorie: category, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const today = toBerlinDate(new Date());
  const defaultFrom = cal?.nextSchoolDay(addDays(today, 1)) ?? addDays(today, 1);
  const liveInitial = active
    ? [{ id: run.id, status: run.status, progress: run.progress, cancelRequested: run.cancelRequested, heartbeatAt: run.heartbeatAt?.toISOString() ?? null, note: run.log.at(-1)?.text ?? null }]
    : [];

  return (
    <RunLiveProvider key={`${run.id}:${run.status}`} initial={liveInitial}>
      <main className="flex flex-col gap-6">
        <Link href="/planung/solver" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          <ArrowLeft aria-hidden className="size-4" /> Alle Läufe
        </Link>
        <PageHeader
          eyebrow="Stundenplanung · Automatisch planen"
          title={runTitle(run)}
          actions={
            <>
              {active && !run.cancelRequested && (
                <form action={cancelSolverAction.bind(null, run.id, base)} aria-label="Lauf abbrechen">
                  <Button type="submit" size="sm">
                    Abbrechen
                  </Button>
                </form>
              )}
              {canDeleteRun(run) && <DeleteRun id={run.id} applied={run.status === "applied"} />}
            </>
          }
        />
        <div className="-mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          <LiveStatusBadge id={run.id} status={run.status} />
          <span>
            gestartet {timeFmt.format(run.createdAt)} von {run.createdBy ? (nameOf.get(run.createdBy) ?? "–") : "Konto gelöscht"}
            {run.finishedAt ? ` · beendet ${timeFmt.format(run.finishedAt)}` : ""}
            {m ? ` · Dauer ${duration(m.durationMs)}` : ""}
          </span>
        </div>

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
        {active && (
          <Card aria-labelledby="prog-title">
            <h2 id="prog-title" className="text-base font-semibold">
              {run.status === "queued" ? "Wartet auf die Berechnung" : "Berechnung läuft"}
            </h2>
            <LiveProgress id={run.id} />
            <p className="text-xs text-muted">Die Anzeige aktualisiert sich selbst; ist der Lauf fertig, erscheint das Ergebnis.</p>
          </Card>
        )}
        {run.status === "failed" && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            Der Lauf ist fehlgeschlagen: {run.error}
          </p>
        )}
        {run.status === "cancelled" && (
          <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
            Der Lauf wurde abgebrochen, bevor ein Plan entstand.
          </p>
        )}
        {m?.cancelledAt !== undefined && (
          <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
            Vorzeitig beendet bei {m.cancelledAt} % – der Vorschlag ist ein gültiger Plan.
          </p>
        )}
        {run.status === "applied" && run.appliedFrom && (
          <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
            Übernommen ab {dayFmt.format(fromBerlinLocal(run.appliedFrom))}
            {run.appliedBy ? ` von ${nameOf.get(run.appliedBy) ?? "–"}` : ""}
            {run.appliedAt ? ` am ${timeFmt.format(run.appliedAt)}` : ""}.
          </p>
        )}
        {(run.status === "done" || run.status === "applied") && !stored && (
          <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
            Das Ergebnis wurde beim Aufräumen entfernt – Kennzahlen und Protokoll bleiben; zum Übernehmen einen neuen Lauf mit denselben Parametern starten.
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Card aria-labelledby="params-title">
            <h2 id="params-title" className="text-base font-semibold">
              Parameter
            </h2>
            {run.params ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">Gründlichkeit</dt>
                  <dd>{EFFORT_LABELS[run.params.effort]}</dd>
                  <dt className="text-muted">Startwert</dt>
                  <dd className="tabular-nums">{run.params.seed}</dd>
                  <dt className="text-muted">Gewichtung</dt>
                  <dd>{PRESET_LABELS[run.params.preset]}</dd>
                </dl>
                <Table>
                  <caption className="sr-only">Gewichte des Laufs</caption>
                  <thead>
                    <tr>
                      <th>Gewicht</th>
                      <th className="text-right">Wert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {WEIGHT_FIELDS.map((f) => (
                      <tr key={f.key}>
                        <td>{f.label}</td>
                        <td className="text-right tabular-nums">{run.params!.weights[f.key]}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            ) : (
              <p className="text-sm text-muted">Lauf von vor SP-06 – Startwert {run.seed}, Gewichte nicht gespeichert.</p>
            )}
          </Card>

          <Card aria-labelledby="metrics-title">
            <h2 id="metrics-title" className="text-base font-semibold">
              Kennzahlen
            </h2>
            {m ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Bewertung</dt>
                <dd className="tabular-nums">{num.format(m.score)} (kleiner ist besser)</dd>
                <dt className="text-muted">Einheiten</dt>
                <dd className="tabular-nums">
                  {m.units - m.unplaced} von {m.units} gesetzt
                  {m.unplaced ? (
                    <Badge tone="danger" className="ml-2">
                      {m.unplaced} nicht gesetzt
                    </Badge>
                  ) : null}
                </dd>
                <dt className="text-muted">Hohlstunden Lehrkräfte</dt>
                <dd className="tabular-nums">
                  {m.gaps.teacherTotal} gesamt, höchstens {m.gaps.teacherMax} je Lehrkraft
                </dd>
                <dt className="text-muted">Hohlstunden Klassen</dt>
                <dd className="tabular-nums">
                  {m.gaps.classTotal} gesamt, höchstens {m.gaps.classMax} je Klasse
                </dd>
                <dt className="text-muted">Diagnose</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {(["gaps", "subjectDay", "room"] as const).map((c) => (
                    <Badge key={c} tone={m.diag[c] ? "warn" : "success"}>
                      {DIAGNOSIS_LABELS[c]}: {m.diag[c] || "in Ordnung"}
                    </Badge>
                  ))}
                </dd>
                <dt className="text-muted">Vorprüfung</dt>
                <dd>
                  {m.precheck.errors} Fehler, {m.precheck.warnings} {m.precheck.warnings === 1 ? "Warnung" : "Warnungen"}
                </dd>
                <dt className="text-muted">Verbesserung</dt>
                <dd className="tabular-nums">
                  {num.format(m.steps)} Schritte, {num.format(m.improved)} Verbesserungen
                  {m.pauses ? `, ${num.format(m.pauses)} Pausen für Anfragen` : ""}
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-muted">{active ? "Kommen, sobald der Lauf fertig ist." : "Keine – der Lauf hat kein Ergebnis."}</p>
            )}
          </Card>
        </div>

        <section aria-labelledby="pre-title" className="flex flex-col gap-2">
          <h2 id="pre-title" className="font-display text-xl font-bold">
            Vorprüfung
          </h2>
          {findings === null ? (
            <p className="text-sm text-muted">{active ? "Läuft zu Beginn der Berechnung." : "Nicht vorhanden (Lauf kam nicht so weit oder ist älter)."}</p>
          ) : findings.length === 0 ? (
            <p className="text-sm text-muted">Bedarf passt überall in die freien, ungesperrten Slots.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {findings.map((f, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={f.severity === "error" ? "danger" : "warn"}>{f.severity === "error" ? "passt nicht" : "knapp"}</Badge>
                  <span>{f.message}</span>
                  <span className="text-xs text-muted tabular-nums">
                    Bedarf {f.demand} · frei {f.free}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {stored && (
          <section aria-labelledby="unplaced-title" className="flex flex-col gap-2">
            <h2 id="unplaced-title" className="font-display text-xl font-bold">
              Nicht gesetzt {unplaced.length ? `(${unplaced.length})` : ""}
            </h2>
            {unplaced.length === 0 ? (
              <p className="text-sm text-muted">Alle Einheiten sind gesetzt.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {unplaced.map((u) => (
                  <li key={u.unitId} className="rounded-card border border-danger-soft bg-surface p-3 text-sm">
                    <p className="font-semibold">{u.label}</p>
                    <p className="text-muted">{u.reason}</p>
                    {u.causes?.length ? (
                      <Table className="mt-2">
                        <caption className="sr-only">Woran es bei {u.label} hängt</caption>
                        <thead>
                          <tr>
                            <th>Beteiligt</th>
                            <th className="text-right">frei</th>
                            <th className="text-right">belegt</th>
                            <th className="text-right">gesperrt</th>
                          </tr>
                        </thead>
                        <tbody>
                          {u.causes.map((c, i) => (
                            <tr key={i}>
                              <td>{c.label}</td>
                              <td className={`text-right tabular-nums ${c.free === 0 ? "font-semibold text-danger" : ""}`}>
                                {c.free} von {c.of}
                              </td>
                              <td className="text-right tabular-nums">{c.busy}</td>
                              <td className="text-right tabular-nums">{c.blocked}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {stored && (
          <section aria-labelledby="cost-title" className="flex flex-col gap-3">
            <h2 id="cost-title" className="font-display text-xl font-bold">
              Was die Bewertung kostet
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {categories.map((k) => (
                <div key={k} className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm">
                  <span>{COST_LABELS[k]}</span>
                  <Badge tone={stored.result.breakdown[k] > 0 ? "warn" : stored.result.breakdown[k] < 0 ? "success" : "neutral"}>{stored.result.breakdown[k]}</Badge>
                </div>
              ))}
            </div>
            <nav aria-label="Kostenposten filtern" className="flex flex-wrap gap-1.5">
              {[null, ...categories.filter((c) => countBy.get(c))].map((c) => (
                <Link
                  key={c ?? "alle"}
                  href={keep({ kategorie: c })}
                  scroll={false}
                  aria-current={c === category ? "page" : undefined}
                  className="rounded-full border border-border px-3 py-1 text-sm text-muted hover:text-ink aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
                >
                  {c ? `${COST_LABELS[c]} (${countBy.get(c)})` : `Alle (${stored.result.items.length})`}
                </Link>
              ))}
            </nav>
            {items.length === 0 ? (
              <p className="text-sm text-muted">Keine Abzüge.</p>
            ) : (
              <>
                <CostList items={items.slice(0, COST_ITEMS_SHOWN)} />
                {items.length > COST_ITEMS_SHOWN && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-accent-ink">Weitere {Math.min(items.length, COST_ITEM_LIMIT) - COST_ITEMS_SHOWN} Posten anzeigen</summary>
                    <CostList items={items.slice(COST_ITEMS_SHOWN, COST_ITEM_LIMIT)} />
                  </details>
                )}
              </>
            )}
            {items.length > COST_ITEM_LIMIT && <p className="text-sm text-muted">… und {items.length - COST_ITEM_LIMIT} weitere (teuerste zuerst).</p>}
          </section>
        )}

        {stored && master && (
          <section aria-labelledby="preview-title" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="preview-title" className="font-display text-xl font-bold">
                Vorschau {previewName ? `· ${previewName}` : ""}
              </h2>
              <PreviewPicker
                action={base}
                kategorie={category}
                value={wantPreview ? (sp.vorschau ?? "") : ""}
                groups={groupList.map((g) => ({ value: `g:${g.id}`, label: g.name }))}
                teachers={teachers.map((t) => ({ value: `t:${t.id}`, label: t.code ? `${t.code} – ${t.name}` : t.name }))}
              />
            </div>
            {!wantPreview ? (
              <p className="text-sm text-muted">Klasse, Kurs oder Lehrkraft wählen, um den Vorschlag als Wochenplan zu sehen.</p>
            ) : (
              <Table>
                <caption className="sr-only">Vorschlag {previewName}</caption>
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
                            .filter((l) => l.weekday === wd && l.periodNr === p.nr)
                            .map((l, i) => (
                              <span key={i} className="flex items-center gap-1.5 text-sm">
                                <SubjectBar color={subjectOf.get(l.subjectId)?.color ?? "#999"} className="h-5 w-1 shrink-0" />
                                <span>
                                  <span className="font-medium">{subjectOf.get(l.subjectId)?.name ?? l.subjectId}</span>
                                  <span className="block text-xs text-muted">
                                    {[kind === "g" ? (l.teacherId ? teacherCode.get(l.teacherId) : null) : (groupName.get(l.groupId) ?? l.groupId), l.roomId, l.kept ? "bleibt" : null]
                                      .filter(Boolean)
                                      .join(" · ")}
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
        )}

        {run.status === "done" && stored && (
          <Card aria-labelledby="apply-title">
            <h2 id="apply-title" className="text-base font-semibold">
              Übernehmen
            </h2>
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

        <section aria-labelledby="log-title" className="flex flex-col gap-2">
          <h2 id="log-title" className="font-display text-xl font-bold">
            Protokoll
          </h2>
          {run.log.length === 0 ? (
            <p className="text-sm text-muted">Kein Protokoll (Lauf von vor SP-06).</p>
          ) : (
            <ol className="flex flex-col gap-1.5 text-sm">
              {run.log.map((e, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  {!Number.isNaN(Date.parse(e.at)) && (
                    <time dateTime={e.at} className="text-xs text-muted tabular-nums">
                      {clockFmt.format(new Date(e.at))}
                    </time>
                  )}
                  <Badge tone={LOG_KIND[e.kind]?.tone ?? "neutral"}>{LOG_KIND[e.kind]?.label ?? e.kind}</Badge>
                  <span className="min-w-0 flex-1 break-words">{e.text}</span>
                </li>
              ))}
            </ol>
          )}
          {active && <p className="text-xs text-muted">Das Protokoll wächst während der Berechnung; vollständig nach dem Ende.</p>}
        </section>
      </main>
    </RunLiveProvider>
  );
}

function CostList({ items }: { items: CostItem[] }) {
  return (
    <ul className="flex flex-col gap-1 py-1 text-sm">
      {items.map((i, n) => (
        <li key={n} className="flex gap-2">
          <Badge>{i.cost}</Badge>
          <span className="text-muted">{COST_LABELS[i.category]}:</span> {i.text}
        </li>
      ))}
    </ul>
  );
}
