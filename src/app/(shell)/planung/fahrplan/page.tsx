import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { acknowledgeAction, pruneAcksAction, revokeAckAction, startFahrplanAction, stepDateAction, tickAction } from "@/modules/stundenplan/fahrplan-actions";
import { DIAGNOSIS_LABELS, type DiagnosisCategory } from "@/modules/stundenplan/diagnose";
import {
  ACK_REASON_MAX,
  AMPEL_LABELS,
  fahrplanOffers,
  fahrplanVersions,
  loadFahrplan,
  type Ampel,
  type FahrplanOffer,
  type FahrplanTemplate,
  type LoadedFahrplan,
  type StepStatus,
  type WarningView,
} from "@/modules/stundenplan/fahrplan";
import { actorNames, canSeeVersion, type Viewer } from "@/modules/stundenplan/planpruefung";
import { ensureBaseVersions, getVersion, OPEN_STATUSES, STATUS_LABELS, versionNumber } from "@/modules/stundenplan/planversionen";
import { PLAN_MANAGE, PLAN_REVIEW } from "@/modules/stundenplan/rechte";
import { planningYearForPage } from "../planungsjahr";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input } from "@schulos/ui/field";
import { EmptyState, PageHeader, Progress } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Planungsfahrplan" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));
/** ISO-Daten in Texten der Schritte („ab 2027-02-01“) für die Anzeige umschreiben. */
const deDates = (s: string) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => `${d}.${m}.${y}`);

const AMPEL_TONE: Record<Ampel, "success" | "warn" | "danger"> = { gruen: "success", gelb: "warn", rot: "danger" };
const AmpelIcon = ({ a }: { a: Ampel }) =>
  a === "gruen" ? <CircleCheck aria-hidden className="size-4" /> : a === "gelb" ? <CircleAlert aria-hidden className="size-4" /> : <CircleDot aria-hidden className="size-4" />;
const POINT_TONE: Record<StepStatus["points"][number]["tone"], string> = {
  danger: "text-danger",
  warn: "text-warn",
  info: "text-muted",
  ok: "text-success",
};

const link = "font-medium text-accent-ink hover:underline";

const TEMPLATE_TEXT: Record<FahrplanTemplate, { title: string; text: string; button: string }> = {
  halbjahr: {
    title: "Neues Halbjahr",
    text: "Entwurf aus dem gültigen Plan ab Beginn des 2. Halbjahrs – Lehraufträge, Setzhilfe und „Automatisch planen“ rechnen am Stichtag.",
    button: "Halbjahr planen",
  },
  schuljahr: {
    title: "Neues Schuljahr",
    text: "Fürs folgende Schuljahr: nach Schuljahreswechsel und Versetzung den Plan des Vorjahrs hochgestuft übernehmen (Lehrkraft folgt der Klasse).",
    button: "Schuljahr planen",
  },
  aenderung: {
    title: "Änderung im laufenden Plan",
    text: "Folgeversion aus dem gültigen Plan ab dem nächsten Schultag; die Schritte 2–5 sind eingeklappt.",
    button: "Folgeversion anlegen",
  },
  leer: {
    title: "Leerer Entwurf",
    text: "Neuplanung ohne Stunden (fixierte Stunden werden übernommen) – für einen Neuanfang mit Setzhilfe und Solver.",
    button: "Leeren Entwurf anlegen",
  },
};

type Search = { version?: string; jahr?: string; angelegt?: string; quittiert?: string; fehler?: string };

/**
 * SP3-06 (docs/STUNDENPLAN-LEBENSZYKLUS.md §4): Planungsfahrplan – acht Schritte mit Ampel, offenen Punkten und Sprungzielen, Status aus
 * den Daten (`fahrplan.ts`). Ohne offenen Entwurf: Vorlagen. Schritt 7 quittiert Warnungen mit Begründung (Bedingung fürs Veröffentlichen).
 * Bearbeiten nur `stundenplan.manage`; die Prüfung (`stundenplan.review`) liest Versionen ab „in Prüfung“.
 */
export default async function FahrplanPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user, perms } = await requireUser();
  const viewer: Viewer = { userId: user.id, manage: hasPermission(perms, PLAN_MANAGE), review: hasPermission(perms, PLAN_REVIEW) };
  if (!viewer.manage && !viewer.review) notFound();
  const manage = viewer.manage;
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const schoolData = hasPermission(perms, "verwaltung.school");

  const picked = sp.version ? await getVersion(db, sp.version) : null;
  // SP3-09a: Schuljahr aus dem Kopf des Planungsbereichs; der gewählte Entwurf bzw. `jahr=` stellen ihn um (Deeplink)
  const year = (await planningYearForPage(db, "/planung/fahrplan", sp, picked?.schoolYearId ?? null))?.year ?? null;
  if (!year) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplanung" title="Planungsfahrplan" />
        <EmptyState title="Noch kein Schuljahr">Der Fahrplan gehört zu einem Schuljahr – die Verwaltung legt es unter Stammdaten an.</EmptyState>
      </main>
    );
  }
  await ensureBaseVersions(db, today);
  const drafts = (await fahrplanVersions(db, year.id)).filter((v) => canSeeVersion(viewer, v));
  const version = picked && picked.status !== "verworfen" && canSeeVersion(viewer, picked) ? picked : (drafts[0] ?? null);
  const [loaded, offers] = await Promise.all([version ? loadFahrplan(db, version, today, { schoolData }) : null, manage ? fahrplanOffers(db, year, today) : null]);
  const names = loaded
    ? await actorNames(db, [...Object.values(loaded.checklist.acks).map((a) => a.createdBy), ...Object.values(loaded.checklist.ticks).map((t) => t?.createdBy ?? null)])
    : new Map<string, string>();
  const editable = manage && version !== null && (OPEN_STATUSES as readonly string[]).includes(version.status);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplanung" title="Planungsfahrplan" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Acht Schritte vom Rahmen bis zum Veröffentlichen – eine Checkliste, kein Assistent: Der Stand jedes Schritts kommt aus den Daten, jeder
        Schritt führt dorthin, wo er erledigt wird, und zurückspringen geht jederzeit. Veröffentlicht wird erst, wenn die Diagnose des Entwurfs
        keine Fehler hat und jede Warnung mit Begründung quittiert ist (Schritt 7).
      </p>
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {sp.angelegt && version && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Entwurf {versionNumber(version)} „{version.name}“ angelegt – der gültige Plan ist unverändert. Weiter mit den Schritten unten.
        </p>
      )}
      {sp.quittiert && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          {sp.quittiert === "1" ? "Eine Warnung quittiert." : `${sp.quittiert} Warnungen quittiert.`}
        </p>
      )}

      {drafts.length > 1 && (
        <nav aria-label="Entwurf wählen" className="flex flex-wrap gap-1.5">
          {drafts.map((d) => (
            <Link
              key={d.id}
              href={`/planung/fahrplan?version=${encodeURIComponent(d.id)}`}
              aria-current={d.id === version?.id ? "page" : undefined}
              className="rounded-full border border-border px-3 py-1 text-sm text-muted hover:text-ink aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
            >
              {versionNumber(d)} „{d.name}“
            </Link>
          ))}
        </nav>
      )}

      {loaded ? (
        <FahrplanView l={loaded} editable={editable} names={names} />
      ) : (
        <EmptyState title="Kein Entwurf in Arbeit">
          {manage ? "Mit einer Vorlage unten beginnen – der Fahrplan führt dann Schritt für Schritt bis zum Veröffentlichen." : "Sobald die Stundenplanung einen Entwurf zur Prüfung gibt, erscheint sein Fahrplan hier."}
        </EmptyState>
      )}

      {manage && offers && (loaded ? (
        <details className="rounded-card border border-border bg-surface p-4">
          <summary className="cursor-pointer font-semibold">Weitere Planung beginnen (Vorlagen)</summary>
          <div className="mt-3">
            <Templates yearId={year.id} offers={offers} />
          </div>
        </details>
      ) : (
        <section aria-labelledby="vorlagen-title" className="flex flex-col gap-3">
          <h2 id="vorlagen-title" className="font-display text-xl font-bold">
            Vorlagen
          </h2>
          <Templates yearId={year.id} offers={offers} />
        </section>
      ))}
    </main>
  );
}

function Templates({ yearId, offers }: { yearId: string; offers: Record<FahrplanTemplate, FahrplanOffer> }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {(["halbjahr", "schuljahr", "aenderung", "leer"] as const).map((t) => {
        const o = offers[t];
        const id = `vorlage-${t}`;
        return (
          <li key={t}>
            <article aria-labelledby={id} data-vorlage={t} className="flex h-full min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4">
              <h3 id={id} className="font-semibold">
                {TEMPLATE_TEXT[t].title}
              </h3>
              <p className="text-sm text-muted">{TEMPLATE_TEXT[t].text}</p>
              {o.ok ? (
                <form action={startFahrplanAction.bind(null, yearId, t)} className="mt-auto flex flex-col items-start gap-2">
                  <p className="text-sm">
                    {o.number ? (
                      <>
                        Version <strong>{o.number}</strong> ab{" "}
                      </>
                    ) : (
                      "ab "
                    )}
                    <strong>{date(o.validFrom)}</strong>
                  </p>
                  <Button type="submit" variant="primary" size="sm">
                    {TEMPLATE_TEXT[t].button}
                  </Button>
                </form>
              ) : (
                <p className="mt-auto text-sm text-muted">{o.reason}</p>
              )}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

function FahrplanView({ l, editable, names }: { l: LoadedFahrplan; editable: boolean; names: Map<string, string> }) {
  const { version: v, fahrplan: f } = l;
  const nextStep = f.next ? f.steps.find((s) => s.step === f.next) : null;
  return (
    <>
      <section aria-labelledby="stand-title" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="stand-title" className="min-w-0 font-semibold break-words">
            <span className="font-display text-lg">Version {versionNumber(v)}</span> <span className="block text-sm font-normal text-muted">{v.name}</span>
          </h2>
          <Badge tone={v.status === "gueltig" ? "success" : "soft"}>{STATUS_LABELS[v.status]}</Badge>
        </div>
        <p className="text-sm text-muted">
          {v.validFrom ? (v.status === "gueltig" || v.status === "archiviert" ? `gültig ab ${date(v.validFrom)}` : `vorgemerkt ab ${date(v.validFrom)}`) : "ohne Stichtag"}
          {f.template && ` · Vorlage „${TEMPLATE_TEXT[f.template].title}“`}
        </p>
        <Progress value={(f.done / f.steps.length) * 100} label={`${f.done} von ${f.steps.length} Schritten erledigt`} />
        <p className="text-sm" data-testid="fahrplan-stand">
          <strong>{f.done}</strong> von {f.steps.length} Schritten erledigt
          {nextStep && (
            <>
              {" · "}
              <a href={`#schritt-${nextStep.step}`} className={link}>
                weiter mit Schritt {nextStep.nr}: {nextStep.title}
              </a>
            </>
          )}
        </p>
      </section>
      <ol aria-label="Schritte" className="flex flex-col gap-3">
        {f.steps.map((s) => (
          <StepCard key={s.step} s={s} l={l} editable={editable} names={names} />
        ))}
      </ol>
    </>
  );
}

function StepCard({ s, l, editable, names }: { s: StepStatus; l: LoadedFahrplan; editable: boolean; names: Map<string, string> }) {
  const v = l.version;
  const titleId = `schritt-${s.step}-titel`;
  const body = (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1 text-sm">
        {s.points.map((p, i) => (
          <li key={i} className={POINT_TONE[p.tone]}>
            {deDates(p.text)}
          </li>
        ))}
      </ul>
      {s.links.length > 0 && (
        <nav aria-label={`Sprungziele Schritt ${s.nr}`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {s.links.map((x) => (
            <Link key={x.href} href={x.href} className={link}>
              {x.label}
            </Link>
          ))}
        </nav>
      )}
      {editable && s.ticks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {s.ticks.map((t) => {
            const tick = l.checklist.ticks[t.tick];
            return (
              <form key={t.tick} action={tickAction.bind(null, v.id, s.step, t.tick, !t.done)} className="flex flex-wrap items-center gap-2 text-sm">
                <Button type="submit" size="sm" variant={t.done ? "ghost" : "secondary"} aria-pressed={t.done}>
                  {t.done ? <CircleCheck aria-hidden /> : <CircleDot aria-hidden />} {t.label}
                </Button>
                {t.done && tick && (
                  <span className="text-xs text-muted">
                    {tick.at ? dateTimeFmt.format(new Date(tick.at)) : ""} · {tick.createdBy ? (names.get(tick.createdBy) ?? "Konto gelöscht") : "Konto gelöscht"}
                  </span>
                )}
              </form>
            );
          })}
        </div>
      )}
      {s.step === "pruefen" && <Acknowledgements l={l} editable={editable} names={names} />}
      {editable && (
        <form action={stepDateAction.bind(null, v.id, s.step)} className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Termin (optional)</span>
            <Input type="date" name="date" defaultValue={s.due ?? ""} className="w-44" />
          </label>
          <Button type="submit" size="sm">
            Termin speichern
          </Button>
          {s.due && (
            <Button type="submit" size="sm" variant="ghost" name="clear" value="1">
              Termin entfernen
            </Button>
          )}
        </form>
      )}
    </div>
  );
  return (
    <li id={`schritt-${s.step}`} className="scroll-mt-20">
      <article aria-labelledby={titleId} data-schritt={s.step} data-ampel={s.ampel} className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={titleId} className="min-w-0 font-semibold break-words">
            {s.nr}. {s.title}
          </h2>
          <span className="flex flex-wrap items-center gap-2">
            {s.due && (
              <Badge tone={s.overdue ? "danger" : "neutral"}>
                {s.overdue ? "überfällig: " : "bis "}
                {date(s.due)}
              </Badge>
            )}
            <Badge tone={AMPEL_TONE[s.ampel]} data-testid={`ampel-${s.step}`}>
              <AmpelIcon a={s.ampel} />
              {s.ampel === "rot" && s.open ? `${s.open} offen` : AMPEL_LABELS[s.ampel]}
            </Badge>
          </span>
        </div>
        {s.collapsed ? (
          <details>
            <summary className="cursor-pointer text-sm text-muted">Bei einer Änderung im laufenden Plan meist unverändert – Einzelheiten zeigen</summary>
            <div className="mt-3">{body}</div>
          </details>
        ) : (
          body
        )}
      </article>
    </li>
  );
}

/** Schritt 7: Fehler (nicht quittierbar) und Warnungen je Kategorie – offene mit Begründung quittieren, quittierte zurücknehmen. */
function Acknowledgements({ l, editable, names }: { l: LoadedFahrplan; editable: boolean; names: Map<string, string> }) {
  const gate = l.facts.pruefen.gate;
  const v = l.version;
  const byCategory = new Map<DiagnosisCategory, WarningView[]>();
  for (const w of gate.warnings) byCategory.set(w.finding.category, [...(byCategory.get(w.finding.category) ?? []), w]);
  const who = (id: string | null) => (id ? (names.get(id) ?? "Konto gelöscht") : "Konto gelöscht");
  return (
    <div className="flex flex-col gap-3">
      {gate.errors.length > 0 && (
        <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="font-semibold">Fehler lassen sich nicht quittieren – im Entwurf beheben:</p>
          <ul className="mt-1 list-disc pl-5">
            {gate.errors.slice(0, 10).map((e, i) => (
              <li key={i}>
                {e.target.label}: {e.message}
              </li>
            ))}
            {gate.errors.length > 10 && <li>… und {gate.errors.length - 10} weitere (Diagnose im Entwurf)</li>}
          </ul>
        </div>
      )}
      {[...byCategory.entries()].map(([cat, ws]) => {
        const open = ws.filter((w) => !w.ack);
        const done = ws.filter((w) => w.ack);
        const id = `quittung-${cat}`;
        return (
          <section key={cat} aria-labelledby={id} data-kategorie={cat} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <h3 id={id} className="text-sm font-semibold">
              {DIAGNOSIS_LABELS[cat]}: {ws.length === 1 ? "1 Warnung" : `${ws.length} Warnungen`}, {done.length} quittiert
            </h3>
            {open.length > 0 &&
              (editable ? (
                <form action={acknowledgeAction.bind(null, v.id)} aria-label={`${DIAGNOSIS_LABELS[cat]} quittieren`} className="flex flex-col gap-2">
                  <fieldset className="flex flex-col gap-1">
                    <legend className="mb-1 text-sm text-muted">Offene Warnungen (gewählte werden quittiert)</legend>
                    {open.map((w) => (
                      <label key={w.key} className="flex items-start gap-2 text-sm">
                        <input type="checkbox" name="key" value={w.key} defaultChecked className="mt-1 size-4 shrink-0 accent-[var(--accent)]" />
                        <span className="min-w-0 break-words">
                          {w.finding.target.label}: {w.finding.message}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex min-w-0 grow flex-col gap-1 text-sm">
                      <span className="font-medium">Begründung</span>
                      <Input name="reason" required maxLength={ACK_REASON_MAX} placeholder="warum ist das in Ordnung? keine Gesundheitsangaben" />
                    </label>
                    <Button type="submit" size="sm" variant="primary">
                      Quittieren
                    </Button>
                  </div>
                </form>
              ) : (
                <ul className="flex flex-col gap-1 text-sm text-danger">
                  {open.map((w) => (
                    <li key={w.key}>
                      {w.finding.target.label}: {w.finding.message} – nicht quittiert
                    </li>
                  ))}
                </ul>
              ))}
            {done.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm text-muted">{done.length === 1 ? "1 quittierte Warnung" : `${done.length} quittierte Warnungen`}</summary>
                <ul className="mt-2 flex flex-col gap-2 text-sm">
                  {done.map((w) => (
                    <li key={w.key} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-words">
                        {w.finding.target.label}: {w.finding.message}
                        <span className="block text-xs text-muted">
                          „{w.ack!.reason}“ · {who(w.ack!.createdBy)}
                          {w.ack!.at ? ` · ${dateTimeFmt.format(new Date(w.ack!.at))}` : ""}
                        </span>
                      </span>
                      {editable && (
                        <form action={revokeAckAction.bind(null, v.id, w.key)}>
                          <Button type="submit" size="sm" variant="ghost">
                            Zurücknehmen
                          </Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
      {gate.stale > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {gate.stale === 1 ? "Eine Quittierung gehört" : `${gate.stale} Quittierungen gehören`} zu Warnungen, die es nicht mehr gibt (Entwurf geändert).
          {editable && (
            <form action={pruneAcksAction.bind(null, v.id)}>
              <Button type="submit" size="sm" variant="ghost">
                Aufräumen
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
