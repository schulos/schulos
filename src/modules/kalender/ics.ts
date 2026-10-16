// iCalendar-Export (RFC 5545). Zeiten in UTC, Serien als RRULE, Ganztägiges als DATE.
import { addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";

export interface IcsEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  repeatWeeklyUntil: string | null;
  createdAt: Date;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Zeilen > 75 Oktette falten (RFC 5545 §3.1) – nach Zeichen, UTF-8-sicher genug für unsere Inhalte. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (ymd: string) => ymd.replace(/-/g, "");

export function buildIcs(calendarName: string, events: IcsEvent[], now = new Date()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SchulOS//Kalender//DE", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(calendarName)}`];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@schulos`, `DTSTAMP:${utc(now)}`, `CREATED:${utc(e.createdAt)}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(toBerlinDate(e.startsAt))}`, `DTEND;VALUE=DATE:${dateOnly(toBerlinDate(e.endsAt))}`);
    } else {
      lines.push(`DTSTART:${utc(e.startsAt)}`, `DTEND:${utc(e.endsAt)}`);
    }
    if (e.repeatWeeklyUntil) {
      // UNTIL inklusive: Ende des letzten Serientags (Berlin) in UTC bzw. als DATE bei Ganztägigem
      const until = e.allDay ? dateOnly(e.repeatWeeklyUntil) : utc(fromBerlinLocal(addDays(e.repeatWeeklyUntil, 1)));
      lines.push(`RRULE:FREQ=WEEKLY;UNTIL=${until}`);
    }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
