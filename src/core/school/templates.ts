// Vorlagen je Schulform: Fächerkatalog, Stundentafel (Sek I) und Zeitraster – nur Vorbelegung, alles änderbar.
// Die Stundentafeln sind vereinfacht nach NRW-Vorbild; andere Länder übernehmen sie als Startpunkt und passen an.
import type { RoomKind } from "@/core/db/schema";
import type { SchoolForm, SchoolProfile } from "./catalog";

export interface SubjectTemplate {
  id: string;
  name: string;
  color: string;
  roomKind?: RoomKind;
}

/** Fächer, die die Stundentafeln verwenden (Reihenfolge = Sortierung) */
export const SUBJECT_TEMPLATE: readonly SubjectTemplate[] = [
  { id: "D", name: "Deutsch", color: "#D9480F" },
  { id: "M", name: "Mathematik", color: "#1971C2" },
  { id: "E", name: "Englisch", color: "#7048E8" },
  { id: "F", name: "Französisch", color: "#3B5BDB" },
  { id: "BI", name: "Biologie", color: "#2F9E44", roomKind: "nw" },
  { id: "CH", name: "Chemie", color: "#0C8599", roomKind: "nw" },
  { id: "PH", name: "Physik", color: "#1098AD", roomKind: "nw" },
  { id: "GE", name: "Geschichte", color: "#9C6644" },
  { id: "EK", name: "Erdkunde", color: "#5C940D" },
  { id: "PK", name: "Politik", color: "#C2255C" },
  { id: "SP", name: "Sport", color: "#E8590C", roomKind: "sport" },
  { id: "KU", name: "Kunst", color: "#D6336C", roomKind: "kunst" },
  { id: "MU", name: "Musik", color: "#AE3EC9", roomKind: "musik" },
  { id: "IF", name: "Informatik", color: "#364FC7", roomKind: "informatik" },
  { id: "REL", name: "Religion/Philosophie", color: "#868E96" },
];

/** Wochenstunden je Jahrgang und Fach */
export type Stundentafel = Record<number, Record<string, number>>;

const GESAMTSCHULE: Stundentafel = {
  5: { D: 4, M: 4, E: 4, BI: 2, EK: 2, GE: 2, SP: 3, KU: 2, MU: 2, REL: 2, IF: 1 },
  6: { D: 4, M: 4, E: 4, BI: 2, PH: 2, GE: 2, PK: 1, SP: 3, KU: 2, MU: 2, REL: 2 },
  7: { D: 4, M: 4, E: 4, F: 3, BI: 2, PH: 2, GE: 2, EK: 1, SP: 3, KU: 1, MU: 1, REL: 2 },
  8: { D: 4, M: 4, E: 3, F: 3, CH: 2, PH: 2, BI: 1, GE: 2, PK: 2, SP: 3, KU: 1, REL: 2 },
  9: { D: 4, M: 4, E: 3, F: 3, CH: 2, PH: 2, BI: 2, GE: 2, EK: 1, PK: 1, SP: 2, IF: 1, REL: 2 },
  10: { D: 4, M: 4, E: 3, F: 3, CH: 2, PH: 2, BI: 2, GE: 2, EK: 1, PK: 2, SP: 2, REL: 2 },
};

const GYMNASIUM: Stundentafel = {
  5: { D: 4, M: 4, E: 4, BI: 2, EK: 2, PK: 1, SP: 3, KU: 2, MU: 2, REL: 2, IF: 1 },
  6: { D: 4, M: 4, E: 4, BI: 2, PH: 2, GE: 2, SP: 3, KU: 2, MU: 2, REL: 2 },
  7: { D: 4, M: 4, E: 4, F: 4, BI: 2, PH: 2, GE: 2, EK: 1, SP: 3, KU: 1, MU: 1, REL: 2 },
  8: { D: 4, M: 4, E: 3, F: 4, CH: 2, PH: 2, BI: 1, GE: 2, PK: 2, SP: 3, KU: 1, MU: 1, REL: 2 },
  9: { D: 3, M: 4, E: 3, F: 3, CH: 2, PH: 2, BI: 2, GE: 2, EK: 2, PK: 1, SP: 2, IF: 1, REL: 2 },
  10: { D: 3, M: 3, E: 3, F: 3, CH: 2, PH: 2, BI: 2, GE: 2, EK: 1, PK: 2, SP: 2, KU: 1, MU: 1, REL: 2 },
};

/** Ohne zweite Fremdsprache: die Stunden gehen an Deutsch und Mathematik (ab Jahrgang 7) */
function withoutFrench(t: Stundentafel): Stundentafel {
  return Object.fromEntries(
    Object.entries(t).map(([grade, row]) => {
      const { F, ...rest } = row;
      return [grade, F ? { ...rest, D: (rest.D ?? 0) + 1, M: (rest.M ?? 0) + 1 } : rest];
    }),
  );
}

const STUNDENTAFELN: Record<SchoolForm, Stundentafel> = {
  gesamtschule: GESAMTSCHULE,
  sekundar: GESAMTSCHULE,
  gymnasium: GYMNASIUM,
  realschule: GESAMTSCHULE,
  hauptschule: withoutFrench(GESAMTSCHULE),
  foerderschule: withoutFrench(GESAMTSCHULE),
};

/** Stundentafel der Schulform; nur Jahrgänge, die die Schule laut Profil hat (z. B. Berlin ab 7) */
export function stundentafelTemplate(form: SchoolForm, grades: readonly number[]): Stundentafel {
  const t = STUNDENTAFELN[form];
  return Object.fromEntries(grades.filter((g) => t[g]).map((g) => [g, { ...t[g] }]));
}

export interface TimeGridTemplate {
  id: string;
  name: string;
  periods: { nr: number; startsAt: string; endsAt: string }[];
}

const GANZTAG_45 = [
  { nr: 1, startsAt: "08:00", endsAt: "08:45" },
  { nr: 2, startsAt: "08:50", endsAt: "09:35" },
  { nr: 3, startsAt: "09:55", endsAt: "10:40" },
  { nr: 4, startsAt: "10:45", endsAt: "11:30" },
  { nr: 5, startsAt: "11:50", endsAt: "12:35" },
  { nr: 6, startsAt: "12:40", endsAt: "13:25" },
  { nr: 7, startsAt: "14:15", endsAt: "15:00" },
  { nr: 8, startsAt: "15:05", endsAt: "15:50" },
];

export const TIME_GRIDS: readonly TimeGridTemplate[] = [
  { id: "ganztag-45", name: "45 Minuten, Ganztag (8 Stunden, Mittagspause)", periods: GANZTAG_45 },
  { id: "halbtag-45", name: "45 Minuten, Halbtag (6 Stunden)", periods: GANZTAG_45.slice(0, 6) },
  {
    id: "60",
    name: "60 Minuten (6 Stunden)",
    periods: [
      { nr: 1, startsAt: "08:00", endsAt: "09:00" },
      { nr: 2, startsAt: "09:05", endsAt: "10:05" },
      { nr: 3, startsAt: "10:25", endsAt: "11:25" },
      { nr: 4, startsAt: "11:30", endsAt: "12:30" },
      { nr: 5, startsAt: "13:15", endsAt: "14:15" },
      { nr: 6, startsAt: "14:20", endsAt: "15:20" },
    ],
  },
];

/** Höchste Wochenstundenzahl eines Jahrgangs in der Stundentafel der Schulform. */
export function maxWeeklyHours(form: SchoolForm): number {
  return Math.max(0, ...Object.values(STUNDENTAFELN[form]).map((row) => Object.values(row).reduce((s, h) => s + h, 0)));
}

/**
 * Vorgeschlagenes Zeitraster: Ganztag (8 Stunden) für Gesamt-/Sekundarschulen und für jede Schulform, deren
 * Stundentafel nicht in fünf Vormittage passt (z. B. Gymnasium G9 mit 31 Wochenstunden in Klasse 8), sonst Halbtag.
 */
export function defaultTimeGrid(profile: Pick<SchoolProfile, "form">): TimeGridTemplate {
  const halbtag = TIME_GRIDS.find((g) => g.id === "halbtag-45")!;
  const ganztag = profile.form === "gesamtschule" || profile.form === "sekundar" || maxWeeklyHours(profile.form) > 5 * halbtag.periods.length;
  return TIME_GRIDS.find((g) => g.id === (ganztag ? "ganztag-45" : "halbtag-45"))!;
}
