import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { createDraftAction, createFromTemplateAction, createNewYearDraftAction } from "@/modules/stundenplan/actions";
import { templateOffers, type PlanTemplate, type TemplateOffer } from "@/modules/stundenplan/laufzeit";
import { newYearTemplate, type NewYearTemplate } from "@/modules/stundenplan/neues-schuljahr";
import { share, yearClosing, type YearArchiveState, type YearStatistics } from "@/modules/stundenplan/schuljahresabschluss";
import { PLAN_MANAGE, PLAN_REVIEW, PLAN_SUBSTITUTE } from "@/modules/stundenplan/rechte";
import { actorNames, canSeeVersion, openCommentCounts, selfApproved, type Viewer } from "@/modules/stundenplan/planpruefung";
import { ensureBaseVersions, listVersions, nextNumber, OPEN_STATUSES, STATUS_LABELS, suggestedValidFrom, versionNumber, type VersionSummary } from "@/modules/stundenplan/planversionen";
import type { PlanVersionSource, PlanVersionStatus } from "@/modules/stundenplan/schema";
import { planningYear } from "@/modules/stundenplan/verteilung";
import { publishedTimeline } from "@/modules/stundenplan/plan-archiv";
import { isPublishUndoable } from "@/modules/stundenplan/veroeffentlichen";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ArchiveYearButton } from "./archive-year-button";
import { DraftForm } from "./draft-form";
import { VersionActions } from "./version-actions";

export const metadata: Metadata = { title: "Planversionen" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const num = new Intl.NumberFormat("de-DE");
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));

const TONES: Record<PlanVersionStatus, "neutral" | "soft" | "warn" | "success" | "danger"> = {
  entwurf: "warn",
  pruefung: "soft",
  freigegeben: "soft",
  gueltig: "success",
  archiviert: "neutral",
  verworfen: "neutral",
};

function sourceText(s: VersionSummary): string {
  const labels: Record<PlanVersionSource, string> = {
    bestand: "Bestand – der Plan vor den Planversionen",
    live_copy: s.parentLabel ? `aus dem gültigen Plan (Version ${s.parentLabel})` : "aus dem gültigen Plan",
    empty: "leer angelegt",
    previous_version: s.parentYearName
      ? `Plan des Schuljahrs ${s.parentYearName} hochgestuft (Version ${s.parentLabel})`
      : s.parentLabel
        ? `Kopie von Version ${s.parentLabel}`
        : "Kopie einer Vorversion",
    variant_of: s.parentLabel ? `Variante von Entwurf ${s.parentLabel}` : "Variante",
    solver_run: "aus einem Solver-Lauf",
  };
  return labels[s.version.source];
}

function periodText(s: VersionSummary): string {
  const v = s.version;
  if (!v.validFrom) return "ohne Stichtag";
  if (v.status === "gueltig") return `gültig ab ${date(v.validFrom)}${v.validUntil ? ` bis ${date(v.validUntil)}` : ""}`;
  if (v.status === "archiviert") return `galt ${date(v.validFrom)} – ${v.validUntil ? date(v.validUntil) : "…"}`;
  return `vorgemerkt ab ${date(v.validFrom)}`;
}

/** Vermerk zur Freigabe: „selbst freigegeben“, wenn dieselbe Person eingereicht bzw. angelegt hat (kein Vier-Augen-Zwang, F-10-3). */
function approvalText(v: VersionSummary["version"], approver: string | null): string {
  return `${v.approvedAt ? dateTimeFmt.format(v.approvedAt) : ""} · ${approver ?? "Konto gelöscht"}${selfApproved(v) ? " (selbst freigegeben)" : ""}`;
}

function VersionCard({ s, manage, openComments, approver, undoable }: { s: VersionSummary; manage: boolean; openComments: number; approver: string | null; undoable: boolean }) {
  const v = s.version;
  const f = s.figures;
  const titleId = `version-${v.id}`;
  const open = (OPEN_STATUSES as readonly string[]).includes(v.status);
  return (
    <li>
      <article aria-labelledby={titleId} data-version={s.label} data-status={v.status} className="flex h-full min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={titleId} className="min-w-0 font-semibold break-words">
            <span className="font-display text-lg">Version {s.label}</span>{" "}
            <span className="block text-sm font-normal text-muted">{v.name}</span>
          </h3>
          <Badge tone={TONES[v.status]}>{STATUS_LABELS[v.status]}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">Stichtag</dt>
          <dd>{periodText(s)}</dd>
          <dt className="text-muted">Quelle</dt>
          <dd>{sourceText(s)}</dd>
          <dt className="text-muted">Stunden</dt>
          <dd data-testid="version-zahlen">
            {num.format(f.lessons)} Wochenstunden · {num.format(f.groups)} {f.groups === 1 ? "Lerngruppe" : "Lerngruppen"} · {num.format(f.teachers)}{" "}
            {f.teachers === 1 ? "Lehrkraft" : "Lehrkräfte"} · {num.format(f.rooms)} {f.rooms === 1 ? "Raum" : "Räume"}
            {f.withoutTeacher > 0 && <span className="block text-xs text-muted">{num.format(f.withoutTeacher)} ohne Lehrkraft</span>}
            {s.figuresOn && <span className="block text-xs text-muted">Stand {date(s.figuresOn)}</span>}
          </dd>
          <dt className="text-muted">Angelegt</dt>
          <dd>
            {dateTimeFmt.format(v.createdAt)}
            {v.source !== "bestand" && ` · ${s.createdByName ?? "Konto gelöscht"}`}
          </dd>
          {v.submittedAt && (v.status === "pruefung" || v.status === "freigegeben") && (
            <>
              <dt className="text-muted">Zur Prüfung</dt>
              <dd>{dateTimeFmt.format(v.submittedAt)}</dd>
            </>
          )}
          {v.approvedAt && (
            <>
              <dt className="text-muted">Freigegeben</dt>
              <dd>{approvalText(v, approver)}</dd>
            </>
          )}
          {open && v.teacherPreview && (
            <>
              <dt className="text-muted">Vorschau</dt>
              <dd>{v.status === "entwurf" ? "für Lehrkräfte an (wirkt ab „in Prüfung“)" : "für Lehrkräfte sichtbar"}</dd>
            </>
          )}
          {v.discardedAt && (
            <>
              <dt className="text-muted">Verworfen</dt>
              <dd>{dateTimeFmt.format(v.discardedAt)}</dd>
            </>
          )}
        </dl>
        {open && (
          <nav aria-label={`Entwurf ${s.label}`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {/* SP3-03: Prüfung, Freigabe, Kommentare und Lehrkräfte-Vorschau */}
            <Link href={`/planung/versionen/pruefung?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
              {v.status === "entwurf" ? "Prüfung & Kommentare" : v.status === "pruefung" ? "Prüfen" : "Freigabe ansehen"}
              {openComments > 0 && ` (${openComments} ${openComments === 1 ? "Kommentar" : "Kommentare"} offen)`}
            </Link>
            {manage && v.status === "entwurf" && (
              <Link href={`/planung/stundenplan?quelle=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
                Im Entwurf arbeiten
              </Link>
            )}
            {/* SP3-06: Planungsfahrplan der Version (acht Schritte, Quittierungen) */}
            <Link href={`/planung/fahrplan?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
              Fahrplan
            </Link>
            <Link href={`/planung/versionen/aenderungen?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
              Änderungen zum gültigen Plan
            </Link>
            {/* SP3-04: freigegebene Versionen veröffentlicht die Planung */}
            {manage && v.status === "freigegeben" && (
              <Link href={`/planung/versionen/veroeffentlichen?version=${encodeURIComponent(v.id)}`} className="font-semibold text-accent-ink hover:underline">
                Veröffentlichen …
              </Link>
            )}
          </nav>
        )}
        {manage && v.status === "gueltig" && v.source !== "bestand" && (
          <nav aria-label={`Version ${s.label}`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href={`/planung/versionen/veroeffentlichen?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
              {undoable ? "Veröffentlichung ansehen / zurücknehmen" : "Veröffentlichung ansehen"}
            </Link>
          </nav>
        )}
        {open && manage && <VersionActions id={v.id} label={`${s.label} „${v.name}“`} />}
      </article>
    </li>
  );
}

/**
 * SP3-01 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1/§7.2): Versionsliste je Schuljahr – Karte je Version mit Status, Stichtag, Quelle und
 * Zahlen; Entwurf anlegen (aus dem gültigen Plan ab Stichtag, leer, aus Vorversion), Variante, Verwerfen. Nur `stundenplan.manage`.
 * SP3-02: je Entwurf „Im Entwurf arbeiten“ und „Änderungen zum gültigen Plan“, Variantenvergleich; Veröffentlichen mit SP3-04.
 * SP3-03: je Entwurf „Prüfung & Kommentare“; die Prüfung (`stundenplan.review`, Schulleitung) sieht die Liste ab „in Prüfung“ – ohne
 * Entwürfe in Arbeit, Verworfenes, Anlegen, Variante und Verwerfen.
 * SP3-04: „Veröffentlichen …“ an freigegebenen Versionen, „Veröffentlichung ansehen / zurücknehmen“ an der gültigen, Zeitstrahl der
 * veröffentlichten Versionen.
 */
export default async function VersionenPage({
  searchParams,
}: {
  searchParams: Promise<{ jahr?: string; angelegt?: string; verworfen?: string; fehler?: string; zurueck?: string; vorlage?: string; archiviert?: string }>;
}) {
  const { user, perms } = await requireUser();
  const viewer: Viewer = { userId: user.id, manage: hasPermission(perms, PLAN_MANAGE), review: hasPermission(perms, PLAN_REVIEW) };
  if (!viewer.manage && !viewer.review) notFound();
  const manage = viewer.manage;
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const years = await db.select().from(schoolYears).orderBy(asc(schoolYears.startsOn));
  const fallback = await planningYear(db);
  const year = years.find((y) => y.id === sp.jahr) ?? fallback;
  if (!year) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplanung" title="Planversionen" />
        <EmptyState title="Noch kein Schuljahr">Planversionen gehören zu einem Schuljahr – die Verwaltung legt es unter Stammdaten an.</EmptyState>
      </main>
    );
  }
  // neue Installation oder Demo: der vorhandene Plan wird „Bestand 1.0“ (idempotent)
  await ensureBaseVersions(db, today);
  const [all, suggestion, nextMajor, nextMinor, timeline, offers, newYear, closing] = await Promise.all([
    listVersions(db, year.id, today),
    suggestedValidFrom(db, year, today),
    nextNumber(db, year.id, "major"),
    nextNumber(db, year.id, "minor"),
    publishedTimeline(db, year.id),
    templateOffers(db, year, today),
    // SP3-07: Vorlage „Neues Schuljahr“ (nur Planung) und Schuljahresabschluss (Kurzstatistik ohne Namen auch für die Prüfung)
    manage ? newYearTemplate(db, year, today, fallback?.id ?? null) : Promise.resolve(null),
    yearClosing(db, viewer, year, today),
  ]);
  const followingYear = years.find((y) => y.startsOn > year.endsOn) ?? null;
  // SP3-03: die Prüfung sieht nur Versionen ab „in Prüfung“ (§5)
  const versions = all.filter((s) => canSeeVersion(viewer, s.version));
  const [comments, approvers] = await Promise.all([
    openCommentCounts(
      db,
      versions.map((s) => s.version.id),
    ),
    actorNames(
      db,
      versions.map((s) => s.version.approvedBy),
    ),
  ]);
  const created = sp.angelegt ? versions.find((s) => s.version.id === sp.angelegt) : undefined;
  const discarded = sp.verworfen ? versions.find((s) => s.version.id === sp.verworfen) : undefined;
  const previous = versions.filter((s) => s.version.status === "archiviert" || s.version.status === "verworfen");
  const valid = versions.find((s) => s.version.status === "gueltig");
  const drafts = versions.filter((s) => (OPEN_STATUSES as readonly string[]).includes(s.version.status));
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplanung" title="Planversionen" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Der gültige Plan bleibt, wie er ist, während ein Entwurf entsteht. Ein Entwurf ist eine eigene Kopie der Stunden – aus dem gültigen Plan ab einem
        Stichtag, leer oder aus einer Vorversion – und wirkt erst, wenn er veröffentlicht wird. Varianten sind weitere Entwürfe mit derselben Nummer;
        veröffentlicht wird genau einer.
      </p>
      {years.length > 1 && (
        <nav aria-label="Schuljahr" className="flex flex-wrap gap-1.5">
          {years.map((y) => (
            <Link
              key={y.id}
              href={`/planung/versionen?jahr=${encodeURIComponent(y.id)}`}
              aria-current={y.id === year.id ? "page" : undefined}
              className="rounded-full border border-border px-3 py-1 text-sm text-muted hover:text-ink aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
            >
              {y.name}
            </Link>
          ))}
        </nav>
      )}
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {created && (
        <div role="status" className="flex flex-col gap-2 rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          <p>
            Entwurf {created.label} „{created.version.name}“ angelegt ({num.format(created.figures.lessons)} Wochenstunden). Der gültige Plan ist unverändert.
          </p>
          {(sp.vorlage === "aenderung" || sp.vorlage === "halbjahr") && <TemplateSteps template={sp.vorlage} versionId={created.version.id} validFrom={created.version.validFrom} />}
          {sp.vorlage === "schuljahr" && <NewYearSteps versionId={created.version.id} planningYear={year.id === fallback?.id} yearName={year.name} />}
        </div>
      )}
      {sp.zurueck && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Version zurück an die Planung gegeben – sie ist wieder ein Entwurf und erscheint hier, sobald sie erneut zur Prüfung kommt.
        </p>
      )}
      {discarded && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Entwurf {discarded.label} „{discarded.version.name}“ verworfen.
        </p>
      )}
      {sp.archiviert && closing.state.archived && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Schuljahr {year.name} archiviert – die Versionen bleiben lesbar.
        </p>
      )}

      <section aria-labelledby="versions-title" className="flex flex-col gap-3">
        <h2 id="versions-title" className="font-display text-xl font-bold">
          Versionen im Schuljahr {year.name}
        </h2>
        {versions.length === 0 ? (
          <EmptyState title="Noch keine Version">Sobald es Stunden gibt, ist der Plan „Bestand 1.0“. Ein Entwurf lässt sich auch leer anlegen.</EmptyState>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {versions.map((s) => (
              <VersionCard
                key={s.version.id}
                s={s}
                manage={manage}
                openComments={comments.get(s.version.id) ?? 0}
                approver={s.version.approvedBy ? (approvers.get(s.version.approvedBy) ?? null) : null}
                undoable={isPublishUndoable(s.version, today)}
              />
            ))}
          </ul>
        )}
        {manage && drafts.length > 1 && (
          <p className="text-sm text-muted">
            {drafts.length} offene Entwürfe – veröffentlicht wird genau einer: Varianten derselben Nummer verwirft das Veröffentlichen, andere Entwürfe bleiben stehen, bis sie verworfen werden.{" "}
            <Link
              href={`/planung/solver/vergleich?versionen=${drafts
                .slice(0, 3)
                .map((d) => encodeURIComponent(d.version.id))
                .join(",")}`}
              className="font-medium text-accent-ink hover:underline"
            >
              Varianten vergleichen
            </Link>
          </p>
        )}
      </section>

      {timeline.length > 0 && (
        <section aria-labelledby="timeline-title" className="flex flex-col gap-2">
          <h2 id="timeline-title" className="font-display text-xl font-bold">
            Zeitstrahl
          </h2>
          <p className="-mt-1 text-sm text-muted">Welche Version wann gilt – je Tag genau eine. Den Plan an einem Tag zeigen Stundenplan und Druck über „Plan am …“.</p>
          <ol aria-label="Veröffentlichte Versionen" className="flex flex-col gap-1 text-sm">
            {timeline.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-2">
                <Badge tone={t.status === "gueltig" ? "success" : "neutral"}>{STATUS_LABELS[t.status]}</Badge>
                <span className="font-medium">Version {t.label}</span>
                <span className="text-muted">„{t.name}“</span>
                <span className="tabular-nums">
                  {t.validFrom ? date(t.validFrom) : "…"} – {t.validUntil ? date(t.validUntil) : "offen"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {manage && <Templates yearId={year.id} offers={offers} newYear={newYear} followingYear={followingYear} />}

      {manage && (
      <Card aria-labelledby="draft-title">
        <h2 id="draft-title" className="text-base font-semibold">
          Neuer Entwurf
        </h2>
        <DraftForm
          action={createDraftAction}
          schoolYearId={year.id}
          suggestion={suggestion}
          bounds={{ min: year.startsOn, max: year.endsOn }}
          numbers={{ major: nextMajor ? versionNumber(nextMajor) : "1.0", minor: nextMinor ? versionNumber(nextMinor) : null }}
          validLabel={valid ? `${valid.label} „${valid.version.name}“` : null}
          previous={previous.map((s) => ({ id: s.version.id, label: `${s.label} „${s.version.name}“ (${STATUS_LABELS[s.version.status]})` }))}
        />
      </Card>
      )}
      {manage ? (
      <p className="text-sm text-muted">
        Gearbeitet wird im Entwurf über „Im Entwurf arbeiten“ (Stundenplan, Setzhilfe, Diagnose) oder „Automatisch planen“ (Übernahme in den Entwurf).
        Bearbeiten lässt sich nur ein Entwurf; nach „Zur Prüfung geben“ ist er nur lesbar, bis er zurück an die Planung geht (eine Freigabe verfällt
        dabei). Eine freigegebene Version veröffentlicht die Planung ab einem Stichtag – unveränderte Stunden bleiben, Vertretungen und Material ziehen um;
        bis zum Stichtag lässt sich das zurücknehmen. Kleine Korrekturen gehen direkt im{" "}
        <Link href="/planung/stundenplan" className="font-medium text-accent-ink hover:underline">
          Stundenplan
        </Link>{" "}
        (Sofort-Korrektur ab dem nächsten Schultag, mit{" "}
        <Link href={`/planung/versionen/korrekturen?jahr=${encodeURIComponent(year.id)}`} className="font-medium text-accent-ink hover:underline">
          Protokoll
        </Link>{" "}
        und Gong an die Betroffenen). Den Weg vom Rahmen bis zum Veröffentlichen führt der{" "}
        <Link href="/planung/fahrplan" className="font-medium text-accent-ink hover:underline">
          Planungsfahrplan
        </Link>
        .
      </p>
      ) : (
        <p className="text-sm text-muted">
          Hier erscheinen Entwürfe, sobald die Stundenplanung sie zur Prüfung gibt. Unter „Prüfen“ stehen Änderungen und Kommentare; freigeben oder
          zurück an die Planung geben geht dort. Veröffentlicht wird danach von der Stundenplanung.
        </p>
      )}

      <YearClosing
        yearId={year.id}
        yearName={year.name}
        endsOn={year.endsOn}
        stats={closing.stats}
        state={closing.state}
        canArchive={closing.canArchive}
        manage={manage}
        namedStats={hasPermission(perms, PLAN_SUBSTITUTE) && year.id === fallback?.id}
      />
    </main>
  );
}

const TEMPLATE_TEXT: Record<PlanTemplate, { title: string; text: string; button: string }> = {
  aenderung: {
    title: "Änderung im laufenden Plan",
    text: "Folgeversion aus dem gültigen Plan ab dem nächsten Schultag: im Entwurf ändern, Änderungen zum gültigen Plan ansehen, zur Prüfung geben, freigeben lassen und veröffentlichen. Betroffene bekommen nur ihre Änderungen.",
    button: "Folgeversion anlegen",
  },
  halbjahr: {
    title: "Neues Halbjahr",
    text: "Entwurf fürs 2. Halbjahr aus dem gültigen Plan ab dessen Beginn: Lehraufträge, Setzhilfe und „Automatisch planen“ rechnen im Entwurf am Stichtag (Lehraufträge am …). Veröffentlicht teilt er den Plan ab dem Stichtag – ersetzt „Periode kopieren“.",
    button: "Entwurf fürs Halbjahr anlegen",
  },
};

/**
 * SP3-05 (§4 Vorlagen): „Änderung im laufenden Plan“ (Folgeversion) und „Neues Halbjahr“ – beide als Entwurf aus dem gültigen Plan.
 * SP3-07: „Neues Schuljahr“ mit den Schritten Schuljahreswechsel → Versetzung → Entwurf aus dem Vorjahr (hochgestuft) bzw. leer.
 */
function Templates({
  yearId,
  offers,
  newYear,
  followingYear,
}: {
  yearId: string;
  offers: Record<PlanTemplate, TemplateOffer>;
  newYear: NewYearTemplate | null;
  followingYear: { id: string; name: string } | null;
}) {
  return (
    <section id="vorlagen" aria-labelledby="templates-title" className="flex flex-col gap-3">
      <h2 id="templates-title" className="font-display text-xl font-bold">
        Vorlagen
      </h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {(["aenderung", "halbjahr"] as const).map((t) => {
          const o = offers[t];
          const id = `template-${t}`;
          return (
            <li key={t}>
              <article aria-labelledby={id} className="flex h-full min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4">
                <h3 id={id} className="font-semibold">
                  {TEMPLATE_TEXT[t].title}
                </h3>
                <p className="text-sm text-muted">{TEMPLATE_TEXT[t].text}</p>
                {o.ok ? (
                  <form action={createFromTemplateAction.bind(null, yearId, t)} className="mt-auto flex flex-col items-start gap-2">
                    <p data-testid={`vorlage-${t}`} className="text-sm">
                      Version <strong>{o.number}</strong> ab <strong>{date(o.validFrom)}</strong>
                    </p>
                    <Button type="submit" variant="primary">
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
        {newYear && <NewYearCard t={newYear} followingYear={followingYear} />}
      </ul>
    </section>
  );
}

/** SP3-07: Vorlage „Neues Schuljahr“ – Schritte mit Stand und Sprungziel, Vorschau des Hochstufens, Anlegen (aus dem Vorjahr oder leer). */
function NewYearCard({ t, followingYear }: { t: NewYearTemplate; followingYear: { id: string; name: string } | null }) {
  const p = t.preview;
  const skipped = p ? p.skipped.courses + p.skipped.coupled + p.skipped.unmapped : 0;
  return (
    <li className="md:col-span-2">
      <article aria-labelledby="template-schuljahr" data-testid="vorlage-neues-schuljahr" className="flex h-full min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <h3 id="template-schuljahr" className="font-semibold">
          Neues Schuljahr
        </h3>
        <p className="text-sm text-muted">
          Entwurf fürs Schuljahr {t.year.name} aus dem Plan des Vorjahrs, hochgestuft: jede Klasse geht an ihre Nachfolgeklasse aus der Versetzung, die
          Lehrkraft folgt der Klasse. Kurse und Bänder werden neu geplant. Die Lehraufträge schlägt danach die Matrix vor („Aus dem Vorjahr übernehmen“).
        </p>
        <ol aria-label="Schritte zum neuen Schuljahr" className="flex flex-col gap-1.5 text-sm">
          {t.steps.map((s) => (
            <li key={s.key} data-step={s.key} data-done={s.done ? "ja" : "nein"} className="flex flex-wrap items-baseline gap-x-2">
              <Badge tone={s.done ? "success" : "warn"}>{s.done ? "erledigt" : "offen"}</Badge>
              {s.href && !s.done ? (
                <Link href={s.href} className="font-medium text-accent-ink hover:underline">
                  {s.label}
                </Link>
              ) : (
                <span className="font-medium">{s.label}</span>
              )}
              <span className="text-muted">{s.detail}</span>
            </li>
          ))}
        </ol>
        {p && (
          <p data-testid="vorlage-schuljahr-vorschau" className="text-sm">
            Aus dem Schuljahr {t.previousYear?.name}: <strong>{num.format(p.lessons)}</strong> Wochenstunden für {num.format(p.classes)}{" "}
            {p.classes === 1 ? "Klasse" : "Klassen"} (Plan am {date(p.reference)}){p.reconstructed ? ", Zuordnung über die Klassennamen" : ""}.
            {skipped > 0 && (
              <span className="block text-xs text-muted">
                Nicht übernommen: {num.format(p.skipped.courses)} Kurs-/AG-Stunden, {num.format(p.skipped.coupled)} gekoppelte Stunden (Bänder),{" "}
                {num.format(p.skipped.unmapped)} Stunden ohne eindeutige Nachfolgeklasse (Abschluss, zusammengelegte Klassen).
              </span>
            )}
            {p.teacherCleared > 0 && <span className="block text-xs text-muted">{num.format(p.teacherCleared)} Stunden ohne Lehrkraft (nicht mehr aktiv).</span>}
            {t.assignmentSuggestions > 0 && (
              <span className="block text-xs text-muted">Lehraufträge des Vorjahrs: bis zu {num.format(t.assignmentSuggestions)} Vorschläge in der Matrix.</span>
            )}
          </p>
        )}
        {t.offer.ok ? (
          <form action={createNewYearDraftAction.bind(null, t.year.id)} className="mt-auto flex flex-col items-start gap-3">
            <p data-testid="vorlage-schuljahr" className="text-sm">
              Version <strong>{t.offer.number}</strong> ab <strong>{date(t.offer.validFrom)}</strong>
            </p>
            <fieldset className="flex flex-col gap-1.5 text-sm">
              <legend className="mb-1 font-medium">Ausgangsbasis</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="base" value="vorjahr" defaultChecked={(p?.lessons ?? 0) > 0} disabled={(p?.lessons ?? 0) === 0} className="size-4 accent-accent" />
                Plan des Vorjahrs, hochgestuft
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="base" value="leer" defaultChecked={(p?.lessons ?? 0) === 0} className="size-4 accent-accent" />
                Leer (neu planen)
              </label>
            </fieldset>
            {!t.planningYear && (
              <p className="text-xs text-muted">
                Stundenplan, Unterrichtsverteilung und „Automatisch planen“ arbeiten im aktuellen Schuljahr – im Entwurf für {t.year.name}, sobald der
                Schuljahreswechsel abgeschlossen ist.
              </p>
            )}
            <Button type="submit" variant="primary">
              Entwurf fürs Schuljahr anlegen
            </Button>
          </form>
        ) : (
          <p className="mt-auto text-sm text-muted">{t.offer.reason}</p>
        )}
        {followingYear && (
          <p className="text-sm">
            <Link href={`/planung/versionen?jahr=${encodeURIComponent(followingYear.id)}#vorlagen`} className="font-medium text-accent-ink hover:underline">
              Neues Schuljahr {followingYear.name} planen
            </Link>
          </p>
        )}
      </article>
    </li>
  );
}

/** SP3-07: nach dem Anlegen „Neues Schuljahr“ – Lehraufträge aus dem Vorjahr (Matrix), im Entwurf arbeiten. */
function NewYearSteps({ versionId, planningYear, yearName }: { versionId: string; planningYear: boolean; yearName: string }) {
  const q = encodeURIComponent(versionId);
  const link = "font-medium underline";
  if (!planningYear)
    return (
      <p>
        Weiter, sobald {yearName} das aktuelle Schuljahr ist (Abschluss des Schuljahreswechsels): Lehraufträge aus dem Vorjahr in der Matrix übernehmen, dann im
        Entwurf planen.
      </p>
    );
  return (
    <nav aria-label="Nächste Schritte" className="flex flex-wrap gap-x-4 gap-y-1">
      <Link href={`/planung/unterricht?ansicht=matrix&vorschlag=vorjahr&quelle=${q}`} className={link}>
        Lehraufträge aus dem Vorjahr übernehmen
      </Link>
      <Link href={`/planung/stundenplan?quelle=${q}`} className={link}>
        Im Entwurf arbeiten
      </Link>
      <Link href={`/planung/solver?quelle=${q}`} className={link}>
        Automatisch planen
      </Link>
    </nav>
  );
}

const pct = (part: number, whole: number) => {
  const s = share(part, whole);
  return s === null ? null : `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(s)} %`;
};

/**
 * SP3-07: Schuljahresabschluss – Kurzstatistik Ausfall/Vertretung ohne Namen (Planung und Prüfung) und „Schuljahr archivieren“ (nur Planung,
 * nach dem Schuljahresende).
 */
function YearClosing({
  yearId,
  yearName,
  endsOn,
  stats,
  state,
  canArchive,
  manage,
  namedStats,
}: {
  yearId: string;
  yearName: string;
  endsOn: string;
  stats: YearStatistics | null;
  state: YearArchiveState;
  canArchive: boolean;
  manage: boolean;
  namedStats: boolean;
}) {
  const tiles = stats
    ? [
        { label: "Stunden laut Plan", value: num.format(stats.planned), hint: "je Lerngruppe an Schultagen" },
        { label: "Entfall", value: num.format(stats.cancel), hint: pct(stats.cancel, stats.planned) },
        { label: "Vertretung", value: num.format(stats.substitute), hint: [pct(stats.substitute, stats.planned), stats.supervision ? `davon ${num.format(stats.supervision)} nur Betreuung` : null].filter(Boolean).join(" · ") || null },
        { label: "Zusammenlegung", value: num.format(stats.merge), hint: null },
        { label: "Verlegung", value: num.format(stats.move), hint: null },
        { label: "Raumänderung", value: num.format(stats.room), hint: null },
      ]
    : [];
  return (
    <section aria-labelledby="closing-title" className="flex flex-col gap-3">
      <h2 id="closing-title" className="font-display text-xl font-bold">
        Schuljahresabschluss {yearName}
      </h2>
      {!stats ? (
        <p className="text-sm text-muted">Das Schuljahr hat noch nicht begonnen – die Kurzstatistik beginnt mit dem ersten Schultag.</p>
      ) : (
        <>
          <p className="-mt-1 text-sm text-muted">
            Ausfall und Vertretung {date(stats.from)} – {date(stats.to)}, nur Zahlen ohne Namen.
            {namedStats && (
              <>
                {" "}
                <Link href="/planung/vertretungen/statistik" className="font-medium text-accent-ink hover:underline">
                  Vertretungsstatistik je Lehrkraft und Klasse
                </Link>
              </>
            )}
          </p>
          <dl data-testid="kurzstatistik" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {tiles.map((t) => (
              <div key={t.label} className="flex min-w-0 flex-col rounded-card border border-border bg-surface p-3">
                <dt className="text-xs text-muted">{t.label}</dt>
                <dd className="font-display text-xl font-bold tabular-nums">{t.value}</dd>
                {t.hint && <dd className="text-xs text-muted">{t.hint}</dd>}
              </div>
            ))}
          </dl>
          {stats.byReason.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2">
              <Table scrollLabel="Änderungen je Grund">
                <caption className="px-4 pt-3 text-left text-sm font-semibold">Änderungen je Grund</caption>
                <thead>
                  <tr>
                    <th>Grund</th>
                    <th className="text-right">Anzahl</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byReason.map((r) => (
                    <tr key={r.reason ?? "ohne"}>
                      <td>{r.label}</td>
                      <td className="text-right tabular-nums">{num.format(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Table scrollLabel="Änderungen je Monat">
                <caption className="px-4 pt-3 text-left text-sm font-semibold">Änderungen je Monat</caption>
                <thead>
                  <tr>
                    <th>Monat</th>
                    <th className="text-right">Entfall</th>
                    <th className="text-right">Vertretung</th>
                    <th className="text-right">andere</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byMonth.map((m) => (
                    <tr key={m.month}>
                      <td>{m.label}</td>
                      <td className="text-right tabular-nums">{num.format(m.cancel)}</td>
                      <td className="text-right tabular-nums">{num.format(m.substitute)}</td>
                      <td className="text-right tabular-nums">{num.format(m.other)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </>
      )}
      {manage && (
        <div data-testid="schuljahr-archiv" className="flex flex-col items-start gap-2 text-sm">
          {state.archived ? (
            <p>
              <Badge tone="neutral">archiviert</Badge> Das Schuljahr ist archiviert – Versionen, Zeitstrahl und „Plan am …“ bleiben lesbar.
            </p>
          ) : canArchive ? (
            <>
              <p className="text-muted">
                Das Schuljahr ist vorbei{state.valid ? ` – Version ${state.valid.label} „${state.valid.name}“ ist noch gültig` : ""}
                {state.open > 0 ? ` · ${state.open} offene ${state.open === 1 ? "Entwurf" : "Entwürfe"}` : ""}. Archivieren schließt es ab; alles bleibt lesbar.
              </p>
              <ArchiveYearButton yearId={yearId} yearName={yearName} open={state.open} />
            </>
          ) : (
            <p className="text-muted">{state.ended ? "Im Schuljahr gibt es keine Version zum Archivieren." : `Archivieren geht nach dem Schuljahresende (${date(endsOn)}).`}</p>
          )}
        </div>
      )}
    </section>
  );
}

/** Nach dem Anlegen aus einer Vorlage: die nächsten Schritte als Links. */
function TemplateSteps({ template, versionId, validFrom }: { template: PlanTemplate; versionId: string; validFrom: string | null }) {
  const q = encodeURIComponent(versionId);
  const link = "font-medium underline";
  return (
    <nav aria-label="Nächste Schritte" className="flex flex-wrap gap-x-4 gap-y-1">
      {template === "halbjahr" && validFrom && (
        <Link href={`/planung/unterricht?quelle=${q}`} className={link}>
          Lehraufträge am {date(validFrom)}
        </Link>
      )}
      <Link href={`/planung/stundenplan?quelle=${q}`} className={link}>
        Im Entwurf arbeiten
      </Link>
      {template === "halbjahr" && (
        <Link href={`/planung/solver?quelle=${q}`} className={link}>
          Automatisch planen{validFrom ? ` (Lehraufträge am ${date(validFrom)})` : ""}
        </Link>
      )}
      <Link href={`/planung/versionen/aenderungen?version=${q}`} className={link}>
        Änderungen zum gültigen Plan
      </Link>
    </nav>
  );
}
