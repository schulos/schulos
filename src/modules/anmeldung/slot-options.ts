// Termine für die Auswahl im Formular (P4-34): auf dem Server fertig beschriftet – so gibt es zwischen Server und Browser
// keine abweichenden Datumsformate (Hydration).
import { TZ, toBerlinDate } from "@/core/time";

export interface SlotOption {
  id: string;
  /** YYYY-MM-DD (Berlin) – zum Gruppieren */
  day: string;
  /** „Mittwoch, 10. Februar 2027“ */
  dayLabel: string;
  /** „14:00–14:30“ */
  time: string;
  free: number;
  room: string | null;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

export function toSlotOptions(slots: { id: string; startsAt: Date; endsAt: Date; free: number; roomName?: string | null }[]): SlotOption[] {
  return slots.map((s) => ({
    id: s.id,
    day: toBerlinDate(s.startsAt),
    dayLabel: dayFmt.format(s.startsAt),
    time: `${timeFmt.format(s.startsAt)}–${timeFmt.format(s.endsAt)}`,
    free: s.free,
    room: s.roomName ?? null,
  }));
}
