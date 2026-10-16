import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleDashed } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ, addDays, fromBerlinLocal, toBerlinDate, weekdayMon0 } from "@/core/time";
import { mySlots, readableClasses } from "@/modules/klassenbuch/service";
import { GAP_SCHOOL_DAYS, gapTitle, openLessons } from "@/modules/klassenbuch/luecken";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Klassenbuch" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const STAFF = ["lehrkraft", "verwaltung", "admin"];

/** Schultag-Navigation: Wochenenden überspringen */
function stepSchoolDay(ymd: string, dir: 1 | -1): string {
  let d = addDays(ymd, dir);
  while (weekdayMon0(d) >= 5) d = addDays(d, dir);
  return d;
}

export default async function KlassenbuchPage({ searchParams }: { searchParams: Promise<{ datum?: string }> }) {
  const { user, perms } = await requireUser();
  if (!STAFF.includes(user.role)) notFound();
  const sp = await searchParams;
  const today = toBerlinDate(new Date());
  // am Wochenende den letzten Freitag zeigen – Einträge werden nachgetragen, nicht vorab
  const fallback = weekdayMon0(today) >= 5 ? stepSchoolDay(today, -1) : today;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.datum ?? "") ? sp.datum! : fallback;
  const db = await getDb();
  // Q5-06: eigene Stunden ohne Eintrag – nur für die angemeldete Person
  const [slots, classes, gaps] = await Promise.all([mySlots(db, user.id, date), readableClasses(db, perms), openLessons(db, user.id)]);
  const open = slots.filter((s) => !s.hasEntry).length;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Klassenbuch"
        title="Meine Stunden"
        actions={
          classes.length > 0 && (
            <Button asChild>
              <Link href={classes.length === 1 ? `/klassenbuch/klasse?gruppe=${classes[0]!.id}` : "/klassenbuch/klasse"}>
                {classes.length === 1 ? `Klassenbuch ${classes[0]!.name}` : "Klassenbücher"}
              </Link>
            </Button>
          )
        }
      />
      {gaps.length > 0 && (
        <section id="offen" aria-label="Ohne Eintrag" className="flex flex-col gap-2 rounded-card border border-warn-border bg-warn-soft p-4">
          <h2 className="font-semibold">
            {gapTitle(gaps.length)} <span className="font-normal text-muted">· letzte {GAP_SCHOOL_DAYS} Schultage, nur für dich sichtbar</span>
          </h2>
          <ul className="flex flex-wrap gap-2">
            {gaps.map((g) => (
              <li key={`${g.lessonId}:${g.date}`}>
                <Link
                  href={`/klassenbuch/eintrag?stunde=${g.lessonId}&datum=${g.date}`}
                  className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 text-sm transition hover:border-border-strong"
                >
                  <span aria-hidden className="h-4 w-1 rounded-full" style={{ background: g.color }} />
                  {shortDay.format(fromBerlinLocal(g.date))} · {g.periodNr}. Std · {g.subjectName} · {g.groupName}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button asChild variant="ghost" size="icon">
          <Link href={`/klassenbuch?datum=${stepSchoolDay(date, -1)}`} aria-label="Vorheriger Schultag">
            <ChevronLeft aria-hidden />
          </Link>
        </Button>
        <Button asChild variant="ghost" size="icon">
          <Link href={`/klassenbuch?datum=${stepSchoolDay(date, 1)}`} aria-label="Nächster Schultag">
            <ChevronRight aria-hidden />
          </Link>
        </Button>
        <h2 className="ml-1 font-semibold">
          {date === today ? "Heute · " : ""}
          {longDay.format(fromBerlinLocal(date))}
          {slots.length > 0 && <span className="font-normal text-muted"> · {open === 0 ? "alles eingetragen" : `${open} offen`}</span>}
        </h2>
      </div>
      {slots.length === 0 ? (
        <EmptyState title="An diesem Tag keine eigenen Stunden" />
      ) : (
        <ul className="flex flex-col gap-2">
          {slots.map((s) => {
            const future = s.date > today;
            const inner = (
              <>
                <span aria-hidden className="w-1.5 shrink-0 self-stretch rounded-full" style={{ background: s.color }} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">
                    {s.periodNr}. Std · {s.subjectName}
                  </span>
                  <span className="text-sm text-muted">
                    {s.groupName}
                    {s.perspective === "covering" && ` · Vertretung für ${s.teacherCode}`}
                  </span>
                </span>
                {future ? (
                  <Badge>noch nicht</Badge>
                ) : s.hasEntry ? (
                  <span className="flex items-center gap-1 text-sm font-medium text-success">
                    <CheckCircle2 aria-hidden className="size-4" /> Eingetragen
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-sm font-medium text-warn">
                    <CircleDashed aria-hidden className="size-4" /> Offen
                  </span>
                )}
              </>
            );
            const cls = cn("flex items-center gap-3 rounded-card border border-border bg-surface p-4", !future && "transition hover:border-border-strong");
            return (
              <li key={s.lessonId}>
                {future ? (
                  <div className={cls}>{inner}</div>
                ) : (
                  <Link href={`/klassenbuch/eintrag?stunde=${s.lessonId}&datum=${s.date}`} className={cls}>
                    {inner}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
