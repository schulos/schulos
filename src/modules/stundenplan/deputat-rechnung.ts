// SP3-DEP: Deputat am Stichtag – reine Rechnung ohne Datenbank (auch im Browser nutzbar, z. B. Teilzeit-Rechenhilfe im Formular).
import type { ReductionReason } from "./schema";

export interface Reduction {
  id: string;
  reason: ReductionReason;
  hours: number;
  note: string | null;
  /** SP3-DEP: gilt ab/bis (einschließlich); `null` = ab Schuljahresbeginn bzw. bis Schuljahresende */
  validFrom: string | null;
  validUntil: string | null;
}

/** SP3-DEP: eigene Angaben je Lehrkraft und Schuljahr (Zeile `timetable_deputies`); alles `null` = Vorgabe der Schulform. */
export interface DeputySettings {
  /** Pflichtstunden (1. Halbjahr bzw. ganzes Schuljahr); `null` = Vorgabe der Schulform */
  obligation: number | null;
  /** Teilzeit-Anteil in Prozent – nur Rechenhilfe und Anzeige, gerechnet wird mit `obligation` */
  employmentPercent: number | null;
  /** Pflichtstunden ab Beginn des 2. Halbjahrs; `null` = wie im 1. Halbjahr */
  obligationTerm2: number | null;
}

/** Ein Halbjahr in der Deputats-Karte: Pflicht und Soll am ersten Tag des Halbjahrs. */
export interface DeputyTerm {
  term: 1 | 2;
  from: string;
  until: string;
  obligation: number;
  target: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** SP3-DEP Rechenhilfe Teilzeit: Vorgabe × Anteil, auf halbe Stunden gerundet (x,25 → x,5; x,75 → x+1). */
export function obligationFromPercent(fallback: number, percent: number): number {
  return Math.round(((fallback * percent) / 100) * 2 + 1e-9) / 2;
}

/** Gilt eine Ermäßigung/Anrechnung am Tag `ymd`? */
export function reductionActiveOn(r: Pick<Reduction, "validFrom" | "validUntil">, ymd: string): boolean {
  return (r.validFrom === null || r.validFrom <= ymd) && (r.validUntil === null || r.validUntil >= ymd);
}

/** Halbjahr am Tag `ymd` (2 ab `term2StartsOn`). */
export function termOn(ymd: string, term2StartsOn: string | null): 1 | 2 {
  return term2StartsOn && ymd >= term2StartsOn ? 2 : 1;
}

export interface DeputyCalc {
  obligation: number;
  isDefault: boolean;
  term: 1 | 2;
  active: Reduction[];
  other: Reduction[];
  target: number;
}

/** SP3-DEP: Pflicht und Soll am Tag `ymd` – rein, ohne Datenbank. */
export function deputyOn(settings: DeputySettings | undefined, reductions: Reduction[], fallback: number, ymd: string, term2StartsOn: string | null): DeputyCalc {
  const term = termOn(ymd, term2StartsOn);
  const term2 = term === 2 ? (settings?.obligationTerm2 ?? null) : null;
  const obligation = term2 ?? settings?.obligation ?? fallback;
  const active = reductions.filter((r) => reductionActiveOn(r, ymd));
  const other = reductions.filter((r) => !reductionActiveOn(r, ymd));
  const target = round1(Math.max(0, obligation - active.reduce((s, r) => s + r.hours, 0)));
  return { obligation, isDefault: term2 === null && (settings?.obligation ?? null) === null, term, active, other, target };
}

/** SP3-DEP: beide Halbjahre (Pflicht/Soll am ersten Tag), wenn sie sich unterscheiden; ohne 2. Halbjahr `null`. */
export function deputyTerms(
  settings: DeputySettings | undefined,
  reductions: Reduction[],
  fallback: number,
  year: { startsOn: string; endsOn: string; term2StartsOn: string | null },
): DeputyTerm[] | null {
  const t2 = year.term2StartsOn;
  if (!t2 || t2 <= year.startsOn || t2 > year.endsOn) return null;
  const a = deputyOn(settings, reductions, fallback, year.startsOn, t2);
  const b = deputyOn(settings, reductions, fallback, t2, t2);
  if (a.obligation === b.obligation && a.target === b.target) return null;
  const dayBefore = new Date(Date.parse(`${t2}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return [
    { term: 1, from: year.startsOn, until: dayBefore, obligation: a.obligation, target: a.target },
    { term: 2, from: t2, until: year.endsOn, obligation: b.obligation, target: b.target },
  ];
}
