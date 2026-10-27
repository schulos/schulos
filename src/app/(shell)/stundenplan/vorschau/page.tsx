import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ, fromBerlinLocal } from "@/core/time";
import { addPreviewCommentAction } from "@/modules/stundenplan/actions";
import { WEEKDAYS } from "@/modules/stundenplan/manage";
import { ownComments, previewVersions, teacherPreview, type PreviewLesson } from "@/modules/stundenplan/planpruefung";
import { versionNumber } from "@/modules/stundenplan/planversionen";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { cn } from "@schulos/ui/cn";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { PreviewCommentForm } from "./preview-comment-form";

export const metadata: Metadata = { title: "Mein Plan – Vorschau" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));
const DAY_NAMES = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"] as const;

function LessonChip({ l, from }: { l: PreviewLesson; from: string | null }) {
  const notes = [
    l.week !== "all" ? `${l.week}-Woche` : null,
    from && l.validFrom > from ? `ab ${date(l.validFrom)}` : null,
    l.validUntil ? `bis ${date(l.validUntil)}` : null,
  ].filter(Boolean);
  return (
    <div className="flex gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
      <span aria-hidden className="w-1 shrink-0 self-stretch rounded-full" style={{ background: l.subjectColor ?? undefined }} />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium [overflow-wrap:anywhere]">{l.subjectName}</span>
        <span className="text-xs text-muted">
          {l.groupName}
          {l.roomId ? ` · R ${l.roomId}` : ""}
        </span>
        {notes.length > 0 && <span className="text-xs text-muted">{notes.join(" · ")}</span>}
      </span>
    </div>
  );
}

/**
 * SP3-03 (F-10-4, docs/STUNDENPLAN-LEBENSZYKLUS.md §5): Vorschau „Mein Plan ab …“ – die Lehrkraft sieht **nur ihre eigenen Stunden** einer
 * Planversion, deren Vorschau die Planung eingeschaltet hat (nur in Prüfung/freigegeben), und schreibt der Planung einen Kommentar. Keine
 * anderen Lehrkräfte, keine Kommentare anderer, keine Diagnose. Ohne freigeschaltete Vorschau: Hinweis bzw. 404 für eine fremde Version.
 */
export default async function VorschauPage({ searchParams }: { searchParams: Promise<{ version?: string; gesendet?: string }> }) {
  const { user } = await requireUser();
  if (user.role !== "lehrkraft") notFound();
  const sp = await searchParams;
  const db = await getDb();
  const versions = await previewVersions(db);
  const chosen = sp.version ? versions.find((v) => v.id === sp.version) : versions[0];
  if (sp.version && !chosen) notFound();
  if (!chosen) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplan" title="Mein Plan – Vorschau" />
        <EmptyState title="Gerade keine Vorschau">
          Sobald die Stundenplanung einen neuen Plan zur Prüfung gibt und die Vorschau einschaltet, siehst du hier deinen eigenen Plan ab dem Stichtag.
        </EmptyState>
      </main>
    );
  }
  const [preview, comments, master] = await Promise.all([teacherPreview(db, user.id, chosen.id), ownComments(db, user.id, chosen.id), timetableMasterData(db)]);
  if (!preview) notFound();
  const from = preview.version.validFrom;
  const lessons = preview.lessons;
  const lastPeriod = Math.max(6, ...lessons.map((l) => l.periodNr));
  const periods = master.periods.filter((p) => p.nr <= lastPeriod);
  const slots = [...new Map(lessons.map((l) => [`${l.weekday}-${l.periodNr}`, l])).values()].map((l) => ({
    value: `${l.weekday}-${l.periodNr}`,
    label: `${DAY_NAMES[l.weekday]} ${l.periodNr}. Stunde – ${l.subjectName}, ${l.groupName}`,
  }));
  const title = `Mein Plan ab ${from ? date(from) : "…"}`;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplan · Vorschau" title={title} />
      <p role="note" data-testid="vorschau-hinweis" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm">
        <strong>Entwurf – kann sich noch ändern.</strong> Version {versionNumber(preview.version)} „{preview.version.name}“ ist{" "}
        {preview.version.status === "freigegeben" ? "freigegeben, aber noch nicht veröffentlicht" : "in Prüfung"}. Du siehst nur deine eigenen Stunden; bis
        zur Veröffentlichung gilt dein bisheriger{" "}
        <Link href="/stundenplan" className="font-medium text-accent-ink hover:underline">
          Stundenplan
        </Link>
        .
      </p>
      {versions.length > 1 && (
        <nav aria-label="Version wählen" className="flex flex-wrap gap-1.5">
          {versions.map((v) => (
            <Link
              key={v.id}
              href={`/stundenplan/vorschau?version=${encodeURIComponent(v.id)}`}
              aria-current={v.id === chosen.id ? "page" : undefined}
              className="rounded-full border border-border px-3 py-1 text-sm text-muted hover:text-ink aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
            >
              Ab {v.validFrom ? date(v.validFrom) : "…"} · Version {versionNumber(v)}
            </Link>
          ))}
        </nav>
      )}

      {lessons.length === 0 ? (
        <EmptyState title="In dieser Version hast du keine Stunden">Wenn das nicht stimmt, schreib der Stundenplanung unten einen Kommentar.</EmptyState>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-card border border-border bg-surface md:block">
            <table className="w-full table-fixed border-collapse text-sm" aria-label={title}>
              <thead>
                <tr>
                  <th className="w-24 px-3 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase">Stunde</th>
                  {WEEKDAYS.map((d) => (
                    <th key={d} className="px-2 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.nr} className="border-t border-border">
                    <td className="px-3 py-2 align-top whitespace-nowrap">
                      <span className="font-semibold">{p.nr}.</span>
                      <span className="block text-xs text-muted tabular-nums">
                        {p.startsAt}–{p.endsAt}
                      </span>
                    </td>
                    {WEEKDAYS.map((d, wd) => (
                      <td key={d} className="px-1.5 py-1.5 align-top">
                        <div className="flex flex-col gap-1">
                          {lessons
                            .filter((l) => l.weekday === wd && l.periodNr === p.nr)
                            .map((l) => (
                              <LessonChip key={l.id} l={l} from={from} />
                            ))}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-5 md:hidden">
            {DAY_NAMES.map((d, wd) => {
              const mine = lessons.filter((l) => l.weekday === wd);
              return (
                <section key={d} aria-label={d} className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold text-muted">{d}</h2>
                  {mine.length === 0 ? (
                    <p className="text-sm text-muted">kein Unterricht</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {mine.map((l) => (
                        <li key={l.id} className="grid grid-cols-[2.5rem_1fr] items-center gap-2">
                          <span className="text-xs font-semibold tabular-nums">{l.periodNr}.</span>
                          <LessonChip l={l} from={from} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      <Card aria-labelledby="rueckmeldung-title" className="flex flex-col gap-3">
        <h2 id="rueckmeldung-title" className="text-base font-semibold">
          Rückmeldung an die Stundenplanung
        </h2>
        {sp.gesendet && (
          <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
            Danke – dein Kommentar ist bei der Stundenplanung.
          </p>
        )}
        <PreviewCommentForm action={addPreviewCommentAction.bind(null, chosen.id)} slots={slots} />
        {comments.length > 0 && (
          <section aria-labelledby="eigene-title" className="flex flex-col gap-2">
            <h3 id="eigene-title" className="text-sm font-semibold">
              Deine Kommentare zu dieser Version
            </h3>
            <ul className="flex flex-col gap-2">
              {comments.map((c) => (
                <li key={c.comment.id} data-testid="eigener-kommentar" className={cn("rounded-lg border border-border px-3 py-2 text-sm")}>
                  <p className="text-xs text-muted">
                    {c.targetText} · {dateTimeFmt.format(c.comment.createdAt)} {c.comment.resolvedAt && <Badge tone="success">erledigt</Badge>}
                  </p>
                  <p className="whitespace-pre-line [overflow-wrap:anywhere]">{c.comment.body}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Card>
    </main>
  );
}
