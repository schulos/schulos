// Zeit-Helfer: SchulOS rechnet fachlich in deutscher Ortszeit (Europe/Berlin),
// unabhängig von der Zeitzone des Servers.
export const TZ = "Europe/Berlin";

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Zerlegt einen Zeitpunkt in Berliner Ortszeit. */
export function berlinParts(d: Date) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second! };
}

/** Offset Berlin–UTC in Minuten zu einem Zeitpunkt (60 im Winter, 120 im Sommer). */
function offsetMinutes(at: Date): number {
  const p = berlinParts(at);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - at.getTime()) / 60000);
}

/** „2026-10-05T14:30" (Berliner Ortszeit) → Date. Auch nur Datum („2026-10-05") = Mitternacht. */
export function fromBerlinLocal(local: string): Date {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m) throw new Error(`Ungültige Zeitangabe: ${local}`);
  const [, y, mo, d, h = "00", mi = "00"] = m;
  const guess = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi);
  // zweimal korrigieren, damit auch Tage mit Zeitumstellung stimmen
  let ts = guess - offsetMinutes(new Date(guess)) * 60000;
  ts = guess - offsetMinutes(new Date(ts)) * 60000;
  return new Date(ts);
}

/** GATE-4c (Code-M3): „2027-02-30“ ist kein Datum – `Date.parse`/`Date.UTC` rollen es still in den März. */
export function isCalendarDate(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** Wie `fromBerlinLocal`, aber ungültige Kalenderdaten und Uhrzeiten (25:00, 2027-04-31) sind ein Fehler statt Überlauf. */
export function fromBerlinLocalStrict(local: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(local);
  if (!m || !isCalendarDate(m[1]!) || (m[2] !== undefined && (+m[2] > 23 || +m[3]! > 59))) throw new Error(`Ungültige Zeitangabe: ${local}`);
  return fromBerlinLocal(local);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Date → „2026-10-05" in Berliner Ortszeit */
export function toBerlinDate(d: Date): string {
  const p = berlinParts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Date → „2026-10-05T14:30" in Berliner Ortszeit (für <input type="datetime-local">) */
export function toBerlinLocal(d: Date): string {
  const p = berlinParts(d);
  return `${toBerlinDate(d)}T${pad(p.h)}:${pad(p.min)}`;
}

/** Kalendertag-Arithmetik auf „YYYY-MM-DD" (zeitzonenfrei). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Wochentag 0=Mo … 6=So für „YYYY-MM-DD" */
export function weekdayMon0(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}

/** Montag der Woche von „YYYY-MM-DD" */
export function mondayOf(ymd: string): string {
  return addDays(ymd, -weekdayMon0(ymd));
}

/** ISO-Kalenderwoche (1–53) für „YYYY-MM-DD" */
export function isoWeek(ymd: string): number {
  const thursday = addDays(ymd, 3 - weekdayMon0(ymd));
  const [y] = thursday.split("-").map(Number);
  const jan1 = `${y}-01-01`;
  const days = (Date.parse(thursday) - Date.parse(jan1)) / 86_400_000;
  return Math.floor(days / 7) + 1;
}
