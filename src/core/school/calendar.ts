// Schulkalender: gesetzliche Feiertage je Bundesland (berechnet) + Ferien und unterrichtsfreie Tage (gepflegt).
// Alle Module fragen hier, ob an einem Tag Unterricht ist.
import { asc } from "drizzle-orm";
import { cache } from "react";
import type { Db } from "@/core/db/client";
import { schoolClosures, type ClosureKind } from "@/core/db/schema";
import { cachedSchoolSettings } from "@/core/settings";
import { addDays, weekdayMon0 } from "@/core/time";
import type { StateCode } from "./catalog";

export interface Holiday {
  date: string;
  name: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Ostersonntag (gregorianisch, Gaußsche Osterformel nach Meeus/Jones/Butcher) */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Landesweit geltende gesetzliche Feiertage eines Jahres. Feiertage, die nur in einzelnen Gemeinden gelten
 * (Fronleichnam in Teilen von Sachsen/Thüringen, Mariä Himmelfahrt in Teilen Bayerns, Augsburger Friedensfest),
 * fehlen bewusst – die Schule trägt sie als unterrichtsfreien Tag ein.
 */
export function publicHolidays(state: StateCode, year: number): Holiday[] {
  const easter = easterSunday(year);
  const e = (days: number) => addDays(easter, days);
  const fixed = (md: string) => `${year}-${md}`;
  const inState = (...states: StateCode[]) => states.includes(state);
  // Buß- und Bettag: Mittwoch vor dem 23. November
  const nov22 = fixed("11-22");
  const repentance = addDays(nov22, -((weekdayMon0(nov22) - 2 + 7) % 7));
  const list: (Holiday | false)[] = [
    { date: fixed("01-01"), name: "Neujahr" },
    inState("BW", "BY", "ST") && { date: fixed("01-06"), name: "Heilige Drei Könige" },
    inState("BE", "MV") && { date: fixed("03-08"), name: "Internationaler Frauentag" },
    { date: e(-2), name: "Karfreitag" },
    { date: e(1), name: "Ostermontag" },
    { date: fixed("05-01"), name: "Tag der Arbeit" },
    { date: e(39), name: "Christi Himmelfahrt" },
    { date: e(50), name: "Pfingstmontag" },
    inState("BW", "BY", "HE", "NW", "RP", "SL") && { date: e(60), name: "Fronleichnam" },
    inState("SL") && { date: fixed("08-15"), name: "Mariä Himmelfahrt" },
    inState("TH") && { date: fixed("09-20"), name: "Weltkindertag" },
    { date: fixed("10-03"), name: "Tag der Deutschen Einheit" },
    inState("BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH") && { date: fixed("10-31"), name: "Reformationstag" },
    inState("BW", "BY", "NW", "RP", "SL") && { date: fixed("11-01"), name: "Allerheiligen" },
    inState("SN") && { date: repentance, name: "Buß- und Bettag" },
    { date: fixed("12-25"), name: "1. Weihnachtstag" },
    { date: fixed("12-26"), name: "2. Weihnachtstag" },
  ];
  return list.filter((h): h is Holiday => !!h).sort((a, b) => a.date.localeCompare(b.date));
}

export interface Closure {
  id: string;
  kind: ClosureKind;
  name: string;
  startsOn: string;
  endsOn: string;
}

export interface DayOff {
  kind: "feiertag" | ClosureKind;
  name: string;
  /** letzter Tag des Zeitraums (bei Ferien), sonst der Tag selbst */
  until: string;
}

/** Schulkalender für ein Bundesland mit den gepflegten Ferien/freien Tagen. Rein, ohne DB – gut testbar. */
export class SchoolCalendar {
  private readonly years = new Map<number, Map<string, string>>();

  constructor(
    readonly state: StateCode,
    readonly closures: readonly Closure[] = [],
  ) {}

  private holidaysOf(year: number): Map<string, string> {
    let m = this.years.get(year);
    if (!m) {
      m = new Map(publicHolidays(this.state, year).map((h) => [h.date, h.name]));
      this.years.set(year, m);
    }
    return m;
  }

  /** Warum an einem Werktag kein Unterricht ist – Feiertag vor Ferien vor freiem Tag; null = Schultag bzw. Wochenende */
  dayOff(ymd: string): DayOff | null {
    const holiday = this.holidaysOf(Number(ymd.slice(0, 4))).get(ymd);
    if (holiday) return { kind: "feiertag", name: holiday, until: ymd };
    let best: Closure | undefined;
    for (const c of this.closures) {
      if (c.startsOn <= ymd && ymd <= c.endsOn && (!best || (best.kind === "frei" && c.kind === "ferien"))) best = c;
    }
    return best ? { kind: best.kind, name: best.name, until: best.endsOn } : null;
  }

  isSchoolDay(ymd: string): boolean {
    return weekdayMon0(ymd) < 5 && !this.dayOff(ymd);
  }

  /** Erster Schultag ab `ymd` (einschließlich); sucht höchstens ein Jahr weit */
  nextSchoolDay(ymd: string): string {
    let d = ymd;
    for (let i = 0; i < 370 && !this.isSchoolDay(d); i++) d = addDays(d, 1);
    return d;
  }

  /** Feiertage und Ferien, die in [from, to] liegen bzw. hineinragen – für Listen und Kalender */
  between(from: string, to: string): { kind: DayOff["kind"]; name: string; startsOn: string; endsOn: string }[] {
    const out: { kind: DayOff["kind"]; name: string; startsOn: string; endsOn: string }[] = [];
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
      for (const [date, name] of this.holidaysOf(y)) if (date >= from && date <= to) out.push({ kind: "feiertag", name, startsOn: date, endsOn: date });
    }
    for (const c of this.closures) if (c.endsOn >= from && c.startsOn <= to) out.push({ kind: c.kind, name: c.name, startsOn: c.startsOn, endsOn: c.endsOn });
    return out.sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  }
}

/** Kalender ohne Feiertage/Ferien – nur Wochenenden (für Tests und als Vorgabe reiner Funktionen) */
export const OPEN_CALENDAR = new (class extends SchoolCalendar {
  override dayOff(): DayOff | null {
    return null;
  }
})("NW");

export async function listClosures(db: Db): Promise<Closure[]> {
  return db.select().from(schoolClosures).orderBy(asc(schoolClosures.startsOn), asc(schoolClosures.name));
}

/** Grund, warum an diesem Tag kein Unterricht ist (für Einzelprüfungen in Services) */
export async function dayOffOn(db: Db, ymd: string): Promise<DayOff | null> {
  return (await loadSchoolCalendar(db)).dayOff(ymd);
}

/** „Herbstferien“, „Feiertag (Tag der Deutschen Einheit)“, „unterrichtsfrei (Pädagogischer Tag)“ */
export function dayOffLabel(off: DayOff): string {
  if (off.kind === "feiertag") return `Feiertag (${off.name})`;
  if (off.kind === "frei") return `unterrichtsfrei (${off.name})`;
  return off.name;
}

/**
 * Lädt den Kalender der Schule (Bundesland aus dem Schulprofil + gepflegte Ferien). Pro Request gecacht (B-56): Heute und
 * Stundenplan fragen ihn aus mehreren Widgets/Services ab.
 */
export const loadSchoolCalendar = cache(async (db: Db): Promise<SchoolCalendar> => {
  const [settings, closures] = await Promise.all([cachedSchoolSettings(db), listClosures(db)]);
  return new SchoolCalendar(settings.profile.state, closures);
});
