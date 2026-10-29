// Sitzplan (P5-01/P5-02): reine Logik für Raster, Tischanordnungen und Sitzverteilung – ohne Datenbank, getestet.
// Koordinaten: Reihe 0 ist vorn (Tafel), Spalte 0 links aus Sicht der Klasse. Raster, Vorlagen und Zellschlüssel teilt sich
// der Sitzplan seit RS-08 mit dem Raumlayout (`src/core/raster.ts`).
import { cellKey, parseCellKey, presetCells, sizeError, sortCells } from "@/core/raster";

export { MAX_COLS, MAX_ROWS, PRESETS, PRESET_LABELS, type Preset } from "@/core/raster";

export interface Seat {
  studentId: string;
  row: number;
  col: number;
}

export const deskKey = cellKey;
export const parseDeskKey = parseCellKey;
/** Tische einer Vorlage im Raster `rows` × `cols`, sortiert von vorn links nach hinten rechts. */
export const presetDesks = presetCells;
/** Tische in Lesereihenfolge (vorn links zuerst). */
export const sortDesks = sortCells;

/** Prüft Raster und Tische; gibt eine Fehlermeldung oder null zurück. */
export function layoutError(rows: number, cols: number, desks: readonly string[]): string | null {
  const size = sizeError(rows, cols);
  if (size) return size;
  const seen = new Set<string>();
  for (const d of desks) {
    const p = parseDeskKey(d);
    if (!p || p.row >= rows || p.col >= cols) return "Ein Tisch liegt außerhalb des Rasters";
    if (seen.has(d)) return "Ein Tisch ist doppelt";
    seen.add(d);
  }
  return null;
}

/**
 * Prüft eine Sitzverteilung gegen Tische und Schüler:innen der Gruppe. Jede Person höchstens einmal, je Tisch höchstens
 * eine Person, nur auf Tischen. Gibt eine Fehlermeldung oder null zurück.
 */
export function seatsError(seats: readonly Seat[], desks: readonly string[], studentIds: ReadonlySet<string>): string | null {
  const deskSet = new Set(desks);
  const people = new Set<string>();
  const taken = new Set<string>();
  for (const s of seats) {
    if (!studentIds.has(s.studentId)) return "Mindestens eine Person gehört nicht zur Gruppe";
    if (people.has(s.studentId)) return "Eine Person sitzt doppelt";
    const k = deskKey(s.row, s.col);
    if (!deskSet.has(k)) return "Ein Platz ist kein Tisch";
    if (taken.has(k)) return "Ein Tisch ist doppelt belegt";
    people.add(s.studentId);
    taken.add(k);
  }
  return null;
}

/** Plätze, die nach einer Änderung der Tische noch gelten (Personen auf entfernten Tischen verlieren ihren Platz). */
export function keepSeatsOnDesks(seats: readonly Seat[], desks: readonly string[]): Seat[] {
  const deskSet = new Set(desks);
  return seats.filter((s) => deskSet.has(deskKey(s.row, s.col)));
}

/** Einfacher Zufallsgenerator mit Startwert (mulberry32) – gleiche Zeichenkette, gleiche Folge. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Verteilt die Schüler:innen auf die Tische: „alphabetisch“ in der übergebenen Reihenfolge (Nachname, Vorname) von vorn
 * links nach hinten rechts, „zufaellig“ gemischt mit Startwert. Mehr Personen als Tische → die übrigen bleiben ohne Platz.
 */
export function arrangeSeats(studentIds: readonly string[], desks: readonly string[], mode: "alphabetisch" | "zufaellig", seed = ""): Seat[] {
  const order = [...studentIds];
  if (mode === "zufaellig") {
    const rnd = seededRandom(seed);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
  }
  return sortDesks(desks)
    .slice(0, order.length)
    .map((d, i) => ({ studentId: order[i]!, ...parseDeskKey(d)! }));
}

/** Initialen für den Platz: Vorname + Nachname, z. B. „LS“. */
export function seatInitials(firstName: string, lastName: string): string {
  return `${firstName.trim()[0] ?? ""}${lastName.trim()[0] ?? ""}`.toUpperCase() || "?";
}
