import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal } from "@/core/time";
import { correctionLog, LOG_ROW_LIMIT } from "@/modules/stundenplan/korrekturprotokoll";
import { PLAN_MANAGE } from "@/modules/stundenplan/rechte";
import type { PlanChangeKind } from "@/modules/stundenplan/schema";
import { planningYearForPage } from "../../planungsjahr";
import { Badge } from "@schulos/ui/badge";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Korrektur-Protokoll" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));

const KIND_LABELS: Record<PlanChangeKind, string> = { split: "geteilt ab Stichtag", inplace: "direkt geändert", delete: "beendet/gelöscht", create: "neu" };

/**
 * SP3-06 (offener Punkt aus SP3-05): Protokoll der Sofort-Korrekturen im gültigen Plan (`timetable_plan_changes`) je Schuljahr – je Aktion
 * Zeitpunkt, handelnde Person, Stichtag, Begründung, Art und die geänderten Stunden. Nur `stundenplan.manage`.
 */
export default async function KorrekturenPage({ searchParams }: { searchParams: Promise<{ jahr?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, PLAN_MANAGE)) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const years = await db.select().from(schoolYears).orderBy(asc(schoolYears.startsOn));
  // SP3-09a: Schuljahr aus dem Kopf des Planungsbereichs; `jahr=` (Deeplink, Jahresauswahl unten) stellt ihn um
  const year = (await planningYearForPage(db, "/planung/versionen/korrekturen", sp))?.year;
  if (!year) notFound();
  const { batches, truncated } = await correctionLog(db, year.id);
  return (
    <main className="flex flex-col gap-6">
      <Link href={`/planung/versionen?jahr=${encodeURIComponent(year.id)}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Planversionen
      </Link>
      <PageHeader eyebrow="Stundenplanung · Planversionen" title="Korrektur-Protokoll" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Sofort-Korrekturen im gültigen Plan des Schuljahrs {year.name} – je Aktion, neueste zuerst. Laufende Stunden werden ab dem Stichtag geteilt (davor bleibt
        alles, wie es war); Betroffene bekamen ihre Änderungen als Gong. Größere Änderungen laufen besser über eine Folgeversion.
      </p>
      {years.length > 1 && (
        <nav aria-label="Schuljahr" className="flex flex-wrap gap-1.5">
          {years.map((y) => (
            <Link
              key={y.id}
              href={`/planung/versionen/korrekturen?jahr=${encodeURIComponent(y.id)}`}
              aria-current={y.id === year.id ? "page" : undefined}
              className="rounded-full border border-border px-3 py-1 text-sm text-muted hover:text-ink aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
            >
              {y.name}
            </Link>
          ))}
        </nav>
      )}
      {batches.length === 0 ? (
        <EmptyState title="Keine Sofort-Korrekturen">In diesem Schuljahr wurde der gültige Plan noch nicht direkt geändert.</EmptyState>
      ) : (
        <ol aria-label="Sofort-Korrekturen" className="flex flex-col gap-3">
          {batches.map((b) => {
            const id = `korrektur-${b.batchId}`;
            const kinds = (Object.keys(b.kinds) as PlanChangeKind[]).filter((k) => b.kinds[k] > 0);
            const lessons = Object.values(b.kinds).reduce((s, x) => s + x, 0);
            return (
              <li key={b.batchId}>
                <article aria-labelledby={id} className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 id={id} className="min-w-0 font-semibold break-words">
                      {dateTimeFmt.format(b.createdAt)} · ab {date(b.validFrom)}
                      <span className="block text-sm font-normal text-muted">
                        {b.actor ?? "Konto gelöscht"}
                        {b.versionLabel ? ` · Version ${b.versionLabel}` : ""} · {lessons === 1 ? "1 Stunde" : `${lessons} Stunden`}
                      </span>
                    </h2>
                    <span className="flex flex-wrap gap-1.5">
                      {kinds.map((k) => (
                        <Badge key={k} tone="neutral">
                          {b.kinds[k]} {KIND_LABELS[k]}
                        </Badge>
                      ))}
                    </span>
                  </div>
                  {b.reason && <p className="text-sm">Begründung: „{b.reason}“</p>}
                  {b.lines.length ? (
                    <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
                      {b.lines.map((line, i) => (
                        <li key={i} className="break-words">
                          {line}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">Nur Zeitraum bzw. Kopplung geändert – keine sichtbare Änderung für Lehrkräfte und Klassen.</p>
                  )}
                  <p className="text-xs text-muted">
                    Änderungsliste an Schüler:innen/Eltern:{" "}
                    {b.notifiedAt ? `versandt ${dateTimeFmt.format(b.notifiedAt)}` : b.notifyAt ? `geplant ${dateTimeFmt.format(b.notifyAt)}` : "keine"}
                  </p>
                </article>
              </li>
            );
          })}
        </ol>
      )}
      {truncated && <p className="text-sm text-muted">Gezeigt werden die neuesten {LOG_ROW_LIMIT} geänderten Stunden.</p>}
    </main>
  );
}
