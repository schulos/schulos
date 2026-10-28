import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { createDraftAction } from "@/modules/stundenplan/actions";
import { PLAN_MANAGE, PLAN_REVIEW } from "@/modules/stundenplan/rechte";
import { actorNames, canSeeVersion, openCommentCounts, selfApproved, type Viewer } from "@/modules/stundenplan/planpruefung";
import { ensureBaseVersions, listVersions, nextNumber, OPEN_STATUSES, STATUS_LABELS, suggestedValidFrom, versionNumber, type VersionSummary } from "@/modules/stundenplan/planversionen";
import type { PlanVersionSource, PlanVersionStatus } from "@/modules/stundenplan/schema";
import { planningYear } from "@/modules/stundenplan/verteilung";
import { publishedTimeline } from "@/modules/stundenplan/plan-archiv";
import { isPublishUndoable } from "@/modules/stundenplan/veroeffentlichen";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
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
    previous_version: s.parentLabel ? `Kopie von Version ${s.parentLabel}` : "Kopie einer Vorversion",
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
export default async function VersionenPage({ searchParams }: { searchParams: Promise<{ jahr?: string; angelegt?: string; verworfen?: string; fehler?: string; zurueck?: string }> }) {
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
  const [all, suggestion, nextMajor, nextMinor, timeline] = await Promise.all([
    listVersions(db, year.id, today),
    suggestedValidFrom(db, year, today),
    nextNumber(db, year.id, "major"),
    nextNumber(db, year.id, "minor"),
    publishedTimeline(db, year.id),
  ]);
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
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Entwurf {created.label} „{created.version.name}“ angelegt ({num.format(created.figures.lessons)} Wochenstunden). Der gültige Plan ist unverändert.
        </p>
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
        bis zum Stichtag lässt sich das zurücknehmen. „Neue Periode“ unter{" "}
        <Link href="/planung/stundenplan" className="font-medium text-accent-ink hover:underline">
          Stundenplan
        </Link>{" "}
        teilt den gültigen Plan weiterhin direkt (bis zur Halbjahres-Vorlage).
      </p>
      ) : (
        <p className="text-sm text-muted">
          Hier erscheinen Entwürfe, sobald die Stundenplanung sie zur Prüfung gibt. Unter „Prüfen“ stehen Änderungen und Kommentare; freigeben oder
          zurück an die Planung geben geht dort. Veröffentlicht wird danach von der Stundenplanung.
        </p>
      )}
    </main>
  );
}
