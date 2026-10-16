// Sitzplan (P5-01/P5-02): reine Logik für Raster, Tischanordnungen und Sitzverteilung – ohne Datenbank, getestet.
// Koordinaten: Reihe 0 ist vorn (Tafel), Spalte 0 links aus Sicht der Klasse.

export const MAX_ROWS = 12;
export const MAX_COLS = 12;

export const PRESETS = ["reihen", "gruppen", "u-form", "alle", "leer"] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_LABELS: Record<Preset, string> = {
  reihen: "Reihen mit Zweiertischen",
  gruppen: "Gruppentische (je 4)",
  "u-form": "U-Form",
  alle: "Alle Felder sind Tische",
  leer: "Leer (Tische selbst setzen)",
};

export interface Seat {
  studentId: string;
  row: number;
  col: number;
}

export const deskKey = (row: number, col: number) => `${row}:${col}`;

export function parseDeskKey(key: string): { row: number; col: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(key);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
}

/** Tische einer Vorlage im Raster `rows` × `cols`, sortiert von vorn links nach hinten rechts. */
export function presetDesks(preset: Preset, rows: number, cols: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const desk =
        preset === "alle" ||
        (preset === "reihen" && c % 3 !== 2) ||
        (preset === "gruppen" && r % 3 !== 2 && c % 3 !== 2) ||
        (preset === "u-form" && (c === 0 || c === cols - 1 || r === rows - 1));
      if (desk) out.push(deskKey(r, c));
    }
  return out;
}

/** Tische in Lesereihenfolge (vorn links zuerst). */
export function sortDesks(desks: readonly string[]): string[] {
  return [...desks].sort((a, b) => {
    const x = parseDeskKey(a)!;
    const y = parseDeskKey(b)!;
    return x.row - y.row || x.col - y.col;
  });
}

/** Prüft Raster und Tische; gibt eine Fehlermeldung oder null zurück. */
export function layoutError(rows: number, cols: number, desks: readonly string[]): string | null {
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) return `Reihen: 1 bis ${MAX_ROWS}`;
  if (!Number.isInteger(cols) || cols < 1 || cols > MAX_COLS) return `Plätze je Reihe: 1 bis ${MAX_COLS}`;
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
