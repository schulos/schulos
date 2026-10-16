import { TZ } from "@/core/time";
import type { Occurrence } from "./service";

export const fmtTime = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
export const fmtDayLong = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
export const fmtDayShort = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
export const fmtMonth = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });

/** „10:45–11:30" oder „ganztägig" */
export function timeRange(o: Pick<Occurrence, "allDay" | "start" | "end">): string {
  if (o.allDay) return "ganztägig";
  return `${fmtTime.format(o.start)}–${fmtTime.format(o.end)}`;
}

/** „YYYY-MM-DD" → Date um 12 Uhr UTC (zum Formatieren reiner Kalendertage ohne Zeitzonenkante) */
export function ymdToDate(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}
