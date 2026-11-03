import Link from "next/link";
import { EVENT_STATUS_LABELS, type EventStatus } from "@/modules/gebaeude/labels";
import { eventPlace, setupText, type EventRow } from "@/modules/gebaeude/veranstaltungen";
import { Badge } from "@schulos/ui/badge";

const TONE: Record<EventStatus, "neutral" | "soft" | "warn" | "success" | "danger"> = {
  freigabe: "warn",
  angemeldet: "warn",
  rueckfrage: "soft",
  bestaetigt: "success",
  abgelehnt: "neutral",
  abgesagt: "neutral",
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  return <Badge tone={TONE[status]}>{EVENT_STATUS_LABELS[status]}</Badge>;
}

/** Eine Veranstaltung als Zeile (Übersicht, Wochenvorschau, eigene Anmeldungen). */
export function EventItem({ e, showOrganizer = false }: { e: EventRow & { seriesMore?: number }; showOrganizer?: boolean }) {
  const extra = setupText(e);
  return (
    <Link
      href={`/gebaeude/veranstaltungen/${e.id}`}
      className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2.5 hover:ring-1 hover:ring-border-strong"
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <EventStatusBadge status={e.status} />
        <span className="text-xs text-muted tabular-nums">{e.span}</span>
        {e.seriesId && <Badge tone="soft">{e.seriesMore ? `Serie · ${e.seriesMore === 1 ? "1 weiterer Termin" : `${e.seriesMore} weitere Termine`}` : "Serie"}</Badge>}
      </span>
      <span className="font-medium leading-snug">{e.title}</span>
      <span className="text-xs text-muted">
        {eventPlace(e)} · {e.persons} {e.persons === 1 ? "Person" : "Personen"}
        {extra && ` · ${extra}`}
        {showOrganizer && e.organizerName && ` · ${e.organizerName}`}
      </span>
    </Link>
  );
}

export function EventList({ items, label, showOrganizer }: { items: (EventRow & { seriesMore?: number })[]; label: string; showOrganizer?: boolean }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {items.map((e) => (
        <li key={e.id}>
          <EventItem e={e} showOrganizer={showOrganizer} />
        </li>
      ))}
    </ul>
  );
}
