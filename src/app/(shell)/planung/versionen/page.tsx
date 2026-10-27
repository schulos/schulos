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
import { PLAN_MANAGE } from "@/modules/stundenplan/rechte";
import { ensureBaseVersions, listVersions, nextNumber, OPEN_STATUSES, STATUS_LABELS, suggestedValidFrom, versionNumber, type VersionSummary } from "@/modules/stundenplan/planversionen";
import type { PlanVersionSource, PlanVersionStatus } from "@/modules/stundenplan/schema";
import { planningYear } from "@/modules/stundenplan/verteilung";
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

function VersionCard({ s }: { s: VersionSummary }) {
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
          {v.discardedAt && (
            <>
              <dt className="text-muted">Verworfen</dt>
              <dd>{dateTimeFmt.format(v.discardedAt)}</dd>
            </>
          )}
        </dl>
        {open && <VersionActions id={v.id} label={`${s.label} „${v.name}“`} />}
      </article>
    </li>
  );
}

/**
 * SP3-01 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1/§7.2): Versionsliste je Schuljahr – Karte je Version mit Status, Stichtag, Quelle und
 * Zahlen; Entwurf anlegen (aus dem gültigen Plan ab Stichtag, leer, aus Vorversion), Variante, Verwerfen. Nur `stundenplan.manage`.
 * Arbeiten im Entwurf (Setzhilfe, Solver) folgt mit SP3-02, Prüfung/Freigabe mit SP3-03, Veröffentlichen mit SP3-04.
 */
export default async function VersionenPage({ searchParams }: { searchParams: Promise<{ jahr?: string; angelegt?: string; verworfen?: string; fehler?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, PLAN_MANAGE)) notFound();
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
  const [versions, suggestion, nextMajor, nextMinor] = await Promise.all([
    listVersions(db, year.id, today),
    suggestedValidFrom(db, year, today),
    nextNumber(db, year.id, "major"),
    nextNumber(db, year.id, "minor"),
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
              <VersionCard key={s.version.id} s={s} />
            ))}
          </ul>
        )}
        {drafts.length > 1 && (
          <p className="text-sm text-muted">
            {drafts.length} offene Entwürfe – veröffentlicht wird genau einer, die anderen bleiben stehen, bis sie verworfen werden.
          </p>
        )}
      </section>

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
      <p className="text-sm text-muted">
        Zum Halbjahreswechsel teilt „Neue Periode“ unter{" "}
        <Link href="/planung/stundenplan" className="font-medium text-accent-ink hover:underline">
          Stundenplan
        </Link>{" "}
        weiterhin den gültigen Plan direkt, bis Entwürfe veröffentlicht werden können.
      </p>
    </main>
  );
}
