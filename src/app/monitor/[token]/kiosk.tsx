"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { MonitorData, MonitorEntry } from "@/modules/monitor/service";
import { cn } from "@schulos/ui/cn";

const TZ = "Europe/Berlin";
const clockFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
/** Zeilen je Seite und Tag; mehr Änderungen werden automatisch durchgeblättert */
const PAGE_SIZE = 12;
const PAGE_MS = 12_000;
const REFRESH_MS = 60_000;

const KIND = {
  cancel: { label: "Entfall", cls: "bg-danger-soft text-danger" },
  substitute: { label: "Vertretung", cls: "bg-warn-soft text-ink" },
  room: { label: "Raumänderung", cls: "bg-accent-soft text-accent-ink" },
  move: { label: "Verlegung", cls: "bg-warn-soft text-ink" },
  merge: { label: "Zusammenlegung", cls: "bg-warn-soft text-ink" },
} as const;

/** Uhr ohne Hydrierungs-Unterschied: Server rendert nichts, der Browser die aktuelle Minute */
const subscribeClock = (cb: () => void) => {
  const id = setInterval(cb, 10_000);
  return () => clearInterval(id);
};
function useMinute(): Date | null {
  const minute = useSyncExternalStore(subscribeClock, () => Math.floor(Date.now() / 60_000), () => null);
  return minute === null ? null : new Date(minute * 60_000);
}

export function Kiosk({ token, initial, logo }: { token: string; initial: MonitorData; logo?: React.ReactNode }) {
  const [data, setData] = useState(initial);
  const now = useMinute();
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const pager = setInterval(() => setTick((t) => t + 1), PAGE_MS);
    const refresh = setInterval(async () => {
      try {
        const res = await fetch(`/api/monitor/${encodeURIComponent(token)}`, { cache: "no-store" });
        if (res.status === 404) return setGone(true);
        if (!res.ok) throw new Error(String(res.status));
        setData((await res.json()) as MonitorData);
        setOfflineSince(null);
      } catch {
        // Netzaussetzer: letzten Stand weiter zeigen und einen Hinweis einblenden
        setOfflineSince((s) => s ?? clockFmt.format(new Date()));
      }
    }, REFRESH_MS);
    return () => {
      clearInterval(pager);
      clearInterval(refresh);
    };
  }, [token]);

  if (gone) {
    return (
      <main className="grid min-h-dvh place-items-center p-8 text-center">
        <h1 className="font-display text-3xl font-bold">Monitor gesperrt</h1>
      </main>
    );
  }

  const staffRoom = data.profile === "lehrerzimmer";
  const sprechtag = data.profile === "sprechtag";
  return (
    <main className="flex h-dvh flex-col gap-4 overflow-hidden p-6 text-lg" data-profile={data.profile}>
      <header className="flex items-end justify-between gap-6 border-b border-border pb-4">
        <div className="flex min-w-0 items-end gap-5">
          {logo}
          <div className="min-w-0">
            <p className="text-base text-muted">{data.school}</p>
            <h1 className="font-display text-4xl font-bold tracking-tight">{sprechtag ? "Elternsprechtag" : "Vertretungsplan"}</h1>
          </div>
        </div>
        <div className="text-right">
          <p className="font-display text-5xl font-bold tabular-nums" aria-label="Uhrzeit">
            {now ? clockFmt.format(now) : " "}
          </p>
          <p className="text-muted">
            {now ? dateFmt.format(now) : ""} · {data.week}-Woche
          </p>
        </div>
      </header>

      {offlineSince && (
        <p role="status" className="rounded-xl bg-warn-soft px-4 py-2 text-base">
          Keine Verbindung seit {offlineSince} Uhr – angezeigt wird der letzte Stand.
        </p>
      )}
      {data.todayOff && (
        <p className="rounded-xl bg-surface-2 px-4 py-2 text-xl font-semibold">Heute kein Unterricht: {data.todayOff}</p>
      )}

      {sprechtag ? (
        <SprechtagPanel data={data.sprechtag ?? null} tick={tick} />
      ) : (
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-2">
          {data.days.map((d) => (
            <DayPanel key={d.date} date={d.date} today={data.today} entries={d.entries} notes={d.notes} tick={tick} staffRoom={staffRoom} />
          ))}
        </div>
      )}

      {data.board && (
        <section aria-label={`Pinnwand ${data.board.title}`} className="flex min-h-0 flex-col gap-2">
          <h2 className="text-xl font-semibold">{data.board.title}</h2>
          <div className="grid min-h-0 gap-4 overflow-hidden" style={{ gridTemplateColumns: `repeat(${Math.max(1, data.board.columns.length)}, minmax(0, 1fr))` }}>
            {data.board.columns.map((col) => (
              <div key={col.title} className="flex min-h-0 flex-col gap-2 rounded-card bg-surface-2 p-3">
                <h3 className="font-semibold">{col.title}</h3>
                {col.cards.slice(0, 6).map((c) => (
                  <div key={c.id} className="rounded-xl bg-surface px-3 py-2">
                    <p className="font-medium">{c.title}</p>
                    {c.body && <p className="line-clamp-2 text-base text-muted">{c.body}</p>}
                    {(c.link || c.file) && <p className="text-base text-muted">{c.link ?? c.file}</p>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {staffRoom && data.duties && data.duties.length > 0 && (
        <section aria-label="Pausenaufsichten" className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-lg">
          <span className="font-semibold">Aufsichten:</span>
          {data.duties.map((d, i) => (
            <span
              key={i}
              className={d.status === "open" ? "rounded-lg bg-danger-soft px-2 font-semibold text-danger" : d.status === "covered" ? "rounded-lg bg-warn-soft px-2" : d.status === "dropped" ? "text-muted line-through" : undefined}
            >
              {d.time} {d.area} {d.status === "open" ? `– offen (${d.teacher})` : d.teacher}
            </span>
          ))}
        </section>
      )}

      {data.events.length > 0 && (
        <section aria-label="Termine heute" className="flex flex-wrap gap-x-6 gap-y-1 text-xl">
          <span className="font-semibold">Heute:</span>
          {data.events.map((e) => (
            <span key={`${e.title}-${e.time}`}>
              {e.title} <span className="text-muted">({e.time})</span>
            </span>
          ))}
        </section>
      )}

      {data.ticker.length > 0 && (
        <section aria-label="Laufband" className="overflow-hidden rounded-xl bg-accent text-accent-fg">
          {/* doppelt, damit das Band nahtlos durchläuft */}
          <div className="flex w-max gap-16 whitespace-nowrap px-6 py-3 text-xl font-semibold motion-safe:animate-ticker">
            {[...data.ticker, ...data.ticker].map((t, i) => (
              <span key={i} aria-hidden={i >= data.ticker.length || undefined}>
                {t}
              </span>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function DayPanel({ date, today, entries, notes, tick, staffRoom }: { date: string; today: string; entries: MonitorEntry[]; notes: string[]; tick: number; staffRoom: boolean }) {
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = tick % pages;
  const rows = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return (
    <section aria-label={dayFmt.format(new Date(`${date}T12:00:00Z`))} className="flex min-h-0 flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl font-bold">
          {date === today ? "Heute, " : ""}
          {dayFmt.format(new Date(`${date}T12:00:00Z`))}
        </h2>
        {pages > 1 && (
          <span className="text-base text-muted">
            Seite {page + 1}/{pages}
          </span>
        )}
      </div>
      {notes.length > 0 && (
        <ul aria-label="Tagesmitteilungen" className="flex flex-col gap-1.5">
          {notes.map((n, i) => (
            <li key={i} className="rounded-xl bg-accent-soft px-3 py-1.5 text-lg font-semibold text-accent-ink">
              {n}
            </li>
          ))}
        </ul>
      )}
      {entries.length === 0 ? (
        <p className="text-xl text-muted">Keine Änderungen.</p>
      ) : (
        <table className="w-full text-left [&_td]:border-t [&_td]:border-border [&_td]:px-2 [&_td]:py-2 [&_th]:px-2 [&_th]:pb-2 [&_th]:text-sm [&_th]:font-semibold [&_th]:text-muted [&_th]:uppercase">
          <thead>
            <tr>
              <th>Klasse</th>
              <th>Std.</th>
              <th>Fach</th>
              <th>Art</th>
              <th>Raum</th>
              {staffRoom && <th>für</th>}
              <th>Vertretung</th>
              <th>Hinweis</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={`${e.group}-${e.period}-${i}`}>
                <td className="font-semibold">{e.group}</td>
                <td className="tabular-nums">{e.period}.</td>
                <td>{e.subject}</td>
                <td>
                  <span className={cn("rounded-lg px-2 py-0.5 text-base font-semibold", e.off ? KIND.cancel.cls : KIND[e.kind].cls)}>{e.label}</span>
                  {e.marker && <span className="ml-2 rounded-lg bg-accent px-2 py-0.5 text-sm font-semibold text-accent-fg">{e.marker === "neu" ? "neu" : "geändert"}</span>}
                </td>
                <td className="whitespace-nowrap">{e.roomShift ?? e.room ?? "–"}</td>
                {staffRoom && <td>{e.absent}</td>}
                <td>{staffRoom && e.substituteName ? `${e.substitute} (${e.substituteName})` : e.substitute}</td>
                <td className="text-muted">{[e.reason, e.note].filter(Boolean).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Profil „Sprechtag“ (P4-53): Lehrkräfte und Räume in zwei Spalten, bei vielen Lehrkräften durchgeblättert. */
function SprechtagPanel({ data, tick }: { data: NonNullable<MonitorData["sprechtag"]> | null; tick: number }) {
  if (!data) return <p className="text-2xl text-muted">Zurzeit ist kein Elternsprechtag geplant.</p>;
  const per = PAGE_SIZE * 2;
  const pages = Math.max(1, Math.ceil(data.rows.length / per));
  const page = tick % pages;
  const rows = data.rows.slice(page * per, (page + 1) * per);
  const half = Math.ceil(rows.length / 2);
  return (
    <section aria-label="Räume am Elternsprechtag" className="flex min-h-0 flex-1 flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl font-bold">
          {data.title} · {data.day} · {data.time}
        </h2>
        {pages > 1 && (
          <span className="text-base text-muted">
            Seite {page + 1}/{pages}
          </span>
        )}
      </div>
      {data.rows.length === 0 ? (
        <p className="text-xl text-muted">Noch keine Räume eingetragen.</p>
      ) : (
        <div className="grid gap-x-10 lg:grid-cols-2">
          {[rows.slice(0, half), rows.slice(half)].map((col, i) => (
            <table key={i} className="w-full text-left text-xl [&_td]:border-t [&_td]:border-border [&_td]:px-2 [&_td]:py-2">
              <tbody>
                {col.map((r) => (
                  <tr key={`${r.teacher}-${r.code}`}>
                    <td>
                      {r.teacher}
                      {r.code && <span className="text-muted"> ({r.code})</span>}
                    </td>
                    <td className="text-right font-semibold">{r.room ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}
    </section>
  );
}
