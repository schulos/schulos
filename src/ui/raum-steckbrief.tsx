// Bausteine des Raumsteckbriefs (RS-02/RS-03), gemeinsam für Seite und Druckansicht. Bekommen bereits gefilterte Daten aus
// `roomProfile()` – hier wird nichts nach Rolle entschieden.
import { Accessibility } from "lucide-react";
import { ROOM_EQUIPMENT_LABELS, ROOM_KIND_LABELS } from "@/core/labels";
import { TZ, fromBerlinLocal } from "@/core/time";
import type { ProfileBlock, ProfileSlot, RoomInfoEntry, RoomProfile } from "@/modules/verwaltung/raumsteckbrief";
import { Badge } from "@schulos/ui/badge";
import { cn } from "@schulos/ui/cn";

const dayShort = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });
export const fmtDay = (ymd: string) => dayShort.format(fromBerlinLocal(ymd));

export function roomTitle(r: { id: string; name: string }): string {
  return r.name === r.id || r.name === `Raum ${r.id}` ? `Raum ${r.id}` : `${r.id} – ${r.name}`;
}

/** Kopfdaten: Art, Gebäude/Etage, Plätze, barrierefrei, Ausstattung grob. */
export function RoomFacts({ room }: { room: RoomProfile["room"] }) {
  const place = [room.building, room.floor].filter(Boolean).join(", ");
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <dt className="text-muted">Art</dt>
        <dd className="font-medium">{ROOM_KIND_LABELS[room.kind]}</dd>
      </div>
      <div>
        <dt className="text-muted">Gebäude/Etage</dt>
        <dd className="font-medium">{place || "–"}</dd>
      </div>
      <div>
        <dt className="text-muted">Plätze</dt>
        <dd className="font-medium tabular-nums">{room.capacity ?? "–"}</dd>
      </div>
      <div>
        <dt className="text-muted">Barrierefrei</dt>
        <dd className="flex items-center gap-1.5 font-medium">
          {room.accessible ? (
            <>
              <Accessibility aria-hidden className="size-4 text-accent" /> ja
            </>
          ) : (
            "nein"
          )}
        </dd>
      </div>
      <div className="sm:col-span-2 lg:col-span-4">
        <dt className="text-muted">Ausstattung</dt>
        <dd className="mt-1 flex flex-wrap gap-1.5">
          {room.equipment.length === 0 ? <span>–</span> : room.equipment.map((e) => <Badge key={e}>{ROOM_EQUIPMENT_LABELS[e] ?? e}</Badge>)}
        </dd>
      </div>
    </dl>
  );
}

export function blockSpanText(b: ProfileBlock): string {
  const days = b.startsOn === b.endsOn ? fmtDay(b.startsOn) : `${fmtDay(b.startsOn)} bis ${fmtDay(b.endsOn)}`;
  const hours = b.fromPeriod === null ? "" : b.fromPeriod === b.toPeriod ? `, ${b.fromPeriod}. Stunde` : `, ${b.fromPeriod}.–${b.toPeriod}. Stunde`;
  return `${days}${hours}`;
}

/** Banner „stillgelegt“ bzw. „gesperrt bis …“ (Entscheidung 10, Projektleitung 2026-10-28). */
export function RoomBanners({ profile }: { profile: Pick<RoomProfile, "room" | "blocks" | "upcomingBlocks"> }) {
  const { room, blocks, upcomingBlocks } = profile;
  if (room.active && blocks.length === 0 && upcomingBlocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {!room.active && (
        <p role="status" className="rounded-lg border border-border-strong bg-surface-2 px-4 py-3 text-sm font-semibold">
          Raum stillgelegt – nicht für Unterricht und Buchungen auswählbar.
        </p>
      )}
      {blocks.map((b, i) => (
        <p key={`a${i}`} role="status" className="rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger">
          <span className="font-semibold">Gesperrt bis {fmtDay(b.endsOn)}</span>
          {b.fromPeriod !== null && <span> ({b.fromPeriod === b.toPeriod ? `${b.fromPeriod}. Stunde` : `${b.fromPeriod}.–${b.toPeriod}. Stunde`})</span>}
          <span> · {b.reasonLabel}</span>
          {b.note && <span> · {b.note}</span>}
        </p>
      ))}
      {upcomingBlocks.map((b, i) => (
        <p key={`u${i}`} className="rounded-lg bg-warn-soft px-4 py-2 text-sm text-warn">
          Geplante Sperre: {blockSpanText(b)} · {b.reasonLabel}
          {b.note && ` · ${b.note}`}
        </p>
      ))}
    </div>
  );
}

/** Ausgefüllte Infofelder als Liste; „nur Personal“ ist gekennzeichnet. */
export function InfoList({ info, staffView }: { info: RoomInfoEntry[]; staffView: boolean }) {
  if (info.length === 0) return <p className="text-sm text-muted">Keine Angaben.</p>;
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {info.map((i) => (
        <div key={i.fieldId} data-sichtbarkeit={i.visibility}>
          <dt className="flex items-center gap-2 text-muted">
            {i.label}
            {staffView && i.visibility === "personal" && <Badge>nur Personal</Badge>}
          </dt>
          <dd className="whitespace-pre-line [overflow-wrap:anywhere]">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SlotCell({ s }: { s: ProfileSlot | undefined }) {
  if (!s || s.state === "frei") return <span className="text-xs text-muted">frei</span>;
  if (!s.kind) return <span className="block rounded-md bg-surface-2 px-1.5 py-1 text-xs font-medium">belegt</span>;
  return (
    <span
      className={cn(
        "block rounded-md px-1.5 py-1 text-xs [overflow-wrap:anywhere]",
        s.kind === "lesson" && "bg-surface-2",
        s.kind === "lesson" && s.moved && "bg-warn-soft text-warn",
        s.kind === "booking" && "bg-accent-soft text-accent-ink",
        s.kind === "blocked" && "bg-danger-soft text-danger",
      )}
    >
      {s.label}
      {s.teacher && <span className="block font-semibold">{s.teacher}</span>}
    </span>
  );
}

/** Wochenbelegung: Zeilen = Stunden, Spalten = Mo–Fr; der heutige Tag ist markiert. */
export function WeekGrid({ week, today, caption }: { week: NonNullable<RoomProfile["week"]>; today: string; caption: string }) {
  const detailed = week.days.some((d) => [...d.slots.values()].some((s) => s.state === "belegt" && s.kind));
  return (
    <div className="relative overflow-x-auto rounded-card border border-border bg-surface print:overflow-visible" role="region" aria-label={caption} tabIndex={0}>
      {/* mit Details (Beschäftigte) breiter und seitlich scrollbar, „frei/belegt“ passt auch auf 360 px */}
      <table className={cn("w-full table-fixed border-collapse text-sm print:min-w-0", detailed && "min-w-[34rem]")}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="w-14 px-2 py-2 text-left text-xs font-semibold text-muted uppercase">
              Std.
            </th>
            {week.days.map((d) => (
              <th
                key={d.date}
                scope="col"
                aria-current={d.date === today ? "date" : undefined}
                className={cn("px-1.5 py-2 text-left text-xs font-semibold text-muted", d.date === today && "text-accent-ink")}
              >
                {fmtDay(d.date)}
                {d.date === today && <span className="block font-bold">heute</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {week.periods.map((p) => (
            <tr key={p.nr} className="border-t border-border">
              <th scope="row" className="px-2 py-1.5 text-left text-xs font-semibold tabular-nums">
                {p.nr}.<span className="block font-normal text-muted">{p.startsAt}</span>
              </th>
              {week.days.map((d) =>
                d.closed ? (
                  p.nr === week.periods[0]?.nr ? (
                    <td key={d.date} rowSpan={week.periods.length} className="bg-surface-2 px-1.5 py-1.5 text-center align-middle text-xs text-muted">
                      {d.closed}
                    </td>
                  ) : null
                ) : (
                  <td key={d.date} className="px-1.5 py-1.5 align-top">
                    <SlotCell s={d.slots.get(p.nr)} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
