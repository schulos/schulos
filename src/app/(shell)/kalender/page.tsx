import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Download, Plus, Repeat } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, mondayOf, toBerlinDate } from "@/core/time";
import { fmtMonth, timeRange, ymdToDate } from "@/modules/kalender/format";
import { listOccurrences, type Occurrence, readableCalendars, schoolDayOffOccurrences } from "@/modules/kalender/service";
import { examOccurrences } from "@/modules/klausurplan/service";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { cn } from "@schulos/ui/cn";
import { EmptyState } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Kalender" };

type View = "monat" | "woche" | "agenda";
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const dayHead = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const dayNum = new Intl.DateTimeFormat("de-DE", { day: "numeric", timeZone: "UTC" });

/** Welche Kalendertage berührt ein Termin? (ganztägig: Ende exklusiv) */
function daysOf(o: Occurrence): string[] {
  const first = toBerlinDate(o.start);
  const last = toBerlinDate(new Date(o.end.getTime() - (o.allDay ? 1 : 0)));
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 60; d = addDays(d, 1)) out.push(d);
  return out;
}

// A11Y-01d: mindestens 24 px hoch (WCAG 2.5.8 Zielgröße) – in der Monatsansicht lagen die Termine sonst 20 px hoch dicht untereinander
function Chip({ o, compact }: { o: Occurrence; compact?: boolean }) {
  return (
    <Link
      href={o.href ?? `/kalender/termin/${o.eventId}`}
      className={cn("flex min-h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs hover:bg-surface-2", o.allDay && "font-medium")}
      style={o.allDay ? { background: `color-mix(in oklab, ${o.color} 16%, transparent)` } : undefined}
      title={`${o.title} · ${timeRange(o)} · ${o.calendar}`}
    >
      {!o.allDay && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: o.color }} />}
      {!compact && !o.allDay && <span className="shrink-0 text-muted tabular-nums">{timeRange(o).slice(0, 5)}</span>}
      <span className="truncate">{o.title}</span>
    </Link>
  );
}

export default async function KalenderPage({ searchParams }: { searchParams: Promise<{ ansicht?: string; datum?: string }> }) {
  const { perms } = await requireUser();
  const sp = await searchParams;
  const view: View = sp.ansicht === "woche" || sp.ansicht === "agenda" ? sp.ansicht : "monat";
  const today = toBerlinDate(new Date());
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(sp.datum ?? "") ? sp.datum! : today;
  const db = await getDb();

  let from: string, to: string, prev: string, next: string, title: string;
  if (view === "monat") {
    const first = `${anchor.slice(0, 7)}-01`;
    from = mondayOf(first);
    to = addDays(from, 42);
    const [y, m] = first.split("-").map(Number);
    prev = new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 10);
    next = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
    title = fmtMonth.format(ymdToDate(first));
  } else if (view === "woche") {
    from = mondayOf(anchor);
    to = addDays(from, 7);
    prev = addDays(from, -7);
    next = addDays(from, 7);
    title = `Woche ab ${dayHead.format(ymdToDate(from))}`;
  } else {
    from = anchor;
    to = addDays(anchor, 30);
    prev = addDays(anchor, -30);
    next = addDays(anchor, 30);
    title = "Die nächsten 30 Tage";
  }

  const [events, examOcc, offOcc, calendars] = await Promise.all([
    listOccurrences(db, perms, from, to),
    examOccurrences(db, perms, from, to),
    schoolDayOffOccurrences(db, from, to),
    readableCalendars(db, perms),
  ]);
  const occ = [...offOcc, ...events, ...examOcc].sort((a, b) => a.start.getTime() - b.start.getTime());
  const byDay = new Map<string, Occurrence[]>();
  for (const o of occ) for (const d of daysOf(o)) byDay.set(d, [...(byDay.get(d) ?? []), o]);
  const href = (p: { ansicht?: View; datum?: string }) => `/kalender?ansicht=${p.ansicht ?? view}&datum=${p.datum ?? anchor}`;
  const monthPrefix = anchor.slice(0, 7);

  return (
    <main className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button asChild size="icon" aria-label="Zurück">
            <Link href={href({ datum: prev })}>
              <ChevronLeft aria-hidden />
            </Link>
          </Button>
          <Button asChild size="icon" aria-label="Weiter">
            <Link href={href({ datum: next })}>
              <ChevronRight aria-hidden />
            </Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href={href({ datum: today })}>Heute</Link>
          </Button>
          <h1 className="ml-1 font-display text-2xl font-bold tracking-tight capitalize sm:text-3xl">{title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="Ansicht" className="inline-flex rounded-xl border border-border bg-surface p-1">
            {(["monat", "woche", "agenda"] as const).map((v) => (
              <Link
                key={v}
                href={href({ ansicht: v })}
                aria-current={v === view ? "page" : undefined}
                className={cn("rounded-lg px-3 py-1.5 text-sm capitalize text-muted", v === view && "bg-accent-soft font-semibold text-accent-ink")}
              >
                {v}
              </Link>
            ))}
          </nav>
          <Button asChild variant="primary">
            <Link href={`/kalender/neu?datum=${anchor}`}>
              <Plus aria-hidden /> Termin
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_240px]">
        {view === "monat" && (
          <div className="overflow-hidden rounded-card border border-border bg-surface">
            <div className="grid grid-cols-7 border-b border-border text-center text-xs font-semibold tracking-wide text-muted uppercase">
              {WEEKDAYS.map((d) => (
                <div key={d} className="py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((d) => {
                const items = byDay.get(d) ?? [];
                const inMonth = d.startsWith(monthPrefix);
                return (
                  <div key={d} data-day={d} className={cn("flex min-h-24 flex-col gap-0.5 border-r border-b border-border p-1 sm:min-h-28", !inMonth && "bg-ground")}>
                    <Link
                      href={href({ ansicht: "woche", datum: d })}
                      className={cn("self-end grid size-7 place-items-center rounded-full text-sm", !inMonth && "text-muted", d === today && "bg-accent font-semibold text-accent-fg")}
                    >
                      {dayNum.format(ymdToDate(d))}
                    </Link>
                    {items.slice(0, 3).map((o) => (
                      <Chip key={`${o.eventId}-${o.start.toISOString()}`} o={o} compact />
                    ))}
                    {items.length > 3 && <span className="px-1.5 text-xs text-muted">+{items.length - 3} weitere</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === "woche" && (
          <div className="grid gap-3 md:grid-cols-7">
            {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => (
              <Card key={d} className={cn("gap-2 p-3", d === today && "border-accent")}>
                <h2 className={cn("text-sm font-semibold", d === today && "text-accent-ink")}>{dayHead.format(ymdToDate(d))}</h2>
                {(byDay.get(d) ?? []).map((o) => (
                  <Chip key={`${o.eventId}-${o.start.toISOString()}`} o={o} />
                ))}
                {!byDay.get(d)?.length && <p className="text-xs text-muted">–</p>}
              </Card>
            ))}
          </div>
        )}

        {view === "agenda" &&
          (occ.length === 0 ? (
            <EmptyState title="Keine Termine in den nächsten 30 Tagen" />
          ) : (
            <ol className="flex flex-col gap-4">
              {[...byDay.keys()].sort().filter((d) => d >= from && d < to).map((d) => (
                <li key={d} className="flex flex-col gap-2">
                  <h2 className={cn("text-sm font-semibold text-muted", d === today && "text-accent-ink")}>
                    {d === today ? "Heute · " : ""}
                    {dayHead.format(ymdToDate(d))}
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {byDay.get(d)!.map((o) => (
                      <li key={`${o.eventId}-${o.start.toISOString()}`}>
                        <Link href={o.href ?? `/kalender/termin/${o.eventId}`} className="flex items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 hover:border-border-strong">
                          <span aria-hidden className="h-9 w-1 shrink-0 rounded-full" style={{ background: o.color }} />
                          <span className="w-24 shrink-0 text-sm text-muted tabular-nums">{timeRange(o)}</span>
                          <span className="flex min-w-0 flex-col">
                            <span className="flex items-center gap-1.5 font-medium">
                              {o.title} {o.recurring && <Repeat className="size-3.5 text-muted" aria-label="Serie" />}
                            </span>
                            <span className="text-xs text-muted">
                              {o.calendar}
                              {o.location && ` · ${o.location}`}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          ))}

        <aside aria-label="Kalender" className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Meine Kalender</h2>
          <ul className="flex flex-col gap-1">
            {calendars.map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                  <span className="truncate">{c.label}</span>
                </span>
                <a href={`/api/kalender/ics?kal=${encodeURIComponent(c.key)}`} className="text-muted hover:text-ink" aria-label={`${c.label} als ICS herunterladen`} title="Als ICS herunterladen">
                  <Download className="size-4" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
          <Link href="/kalender/abo" className="px-2 text-sm text-accent-ink hover:underline">
            In der Kalender-App abonnieren
          </Link>
        </aside>
      </div>
    </main>
  );
}
