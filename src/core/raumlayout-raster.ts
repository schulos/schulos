// RS-08 Raumlayout: reine Logik für Elemente im Raster, Varianten, Platzzahl und Prüfungsplätze – ohne Datenbank, auch in
// Client-Komponenten nutzbar. Raster wie im Sitzplan (bis 12 × 12, Reihe 0 vorn); keine freie Zeichnung (Projektleitung
// 2026-10-28). Nur relative Imports (das Schema importiert diese Datei, drizzle-kit kennt `@/` nicht).
import { MAX_COLS, MAX_ROWS, cellKey, parseCellKey, presetCells, sizeError, sortCells, type Preset } from "./raster";

/** Elemente einer Rasterzelle. „platz“ zählt als Sitzplatz; leere Zellen sind Gang/frei. */
export const LAYOUT_ELEMENTS = ["platz", "tisch", "pult", "tafel", "tuer", "fenster", "schrank", "waschbecken", "abzug"] as const;
export type LayoutElement = (typeof LAYOUT_ELEMENTS)[number];

export const ELEMENT_LABELS: Record<LayoutElement, string> = {
  platz: "Platz",
  tisch: "Tisch ohne Platz",
  pult: "Lehrkraftpult",
  tafel: "Tafel/Display",
  tuer: "Tür",
  fenster: "Fenster",
  schrank: "Schrank",
  waschbecken: "Waschbecken",
  abzug: "Abzug",
};

/** Kurzzeichen im Raster (Druck und Ansicht; die Beschriftung für Screenreader steht am Feld). */
export const ELEMENT_SHORT: Record<LayoutElement, string> = {
  platz: "Platz",
  tisch: "Tisch",
  pult: "Pult",
  tafel: "Tafel",
  tuer: "Tür",
  fenster: "Fenster",
  schrank: "Schrank",
  waschbecken: "Becken",
  abzug: "Abzug",
};

/** Varianten (Backlog RS-08): Reihen, U-Form, Gruppentische, Prüfung, frei. */
export const LAYOUT_VARIANTS = ["reihen", "u-form", "gruppen", "pruefung", "frei"] as const;
export type LayoutVariant = (typeof LAYOUT_VARIANTS)[number];

export const VARIANT_LABELS: Record<LayoutVariant, string> = {
  reihen: "Reihen",
  "u-form": "U-Form",
  gruppen: "Gruppentische",
  pruefung: "Prüfung",
  frei: "frei",
};

/** Vorlage für die Plätze einer Variante (Prüfung: jeder zweite Platz im Schachbrett). */
export const VARIANT_PRESET: Record<LayoutVariant, Preset | null> = {
  reihen: "reihen",
  "u-form": "u-form",
  gruppen: "gruppen",
  pruefung: null,
  frei: null,
};

export const LAYOUT_NAME_MAX = 60;
/** Ein Standard-Layout plus weitere benannte Layouts – zusammen höchstens so viele je Raum. */
export const LAYOUTS_PER_ROOM_MAX = 8;

export type LayoutCells = Record<string, LayoutElement>;

export interface LayoutGrid {
  rows: number;
  cols: number;
  cells: LayoutCells;
}

/** Prüft Raster und Elemente; gibt eine Fehlermeldung oder null zurück. */
export function layoutGridError(g: LayoutGrid): string | null {
  const size = sizeError(g.rows, g.cols, "Spalten");
  if (size) return size;
  if (!g.cells || typeof g.cells !== "object" || Array.isArray(g.cells)) return "Raster fehlt";
  for (const [k, v] of Object.entries(g.cells)) {
    const p = parseCellKey(k);
    if (!p || p.row >= g.rows || p.col >= g.cols) return "Ein Element liegt außerhalb des Rasters";
    if (!(LAYOUT_ELEMENTS as readonly string[]).includes(v)) return "Unbekanntes Element im Raster";
  }
  return null;
}

/** Zellen nur innerhalb des Rasters (z. B. nach dem Verkleinern). */
export function cropCells(cells: LayoutCells, rows: number, cols: number): LayoutCells {
  const out: LayoutCells = {};
  for (const [k, v] of Object.entries(cells)) {
    const p = parseCellKey(k);
    if (p && p.row < rows && p.col < cols) out[k] = v;
  }
  return out;
}

/** Platz-Zellen in Lesereihenfolge (vorn links zuerst). */
export function seatKeys(cells: LayoutCells): string[] {
  return sortCells(Object.keys(cells).filter((k) => cells[k] === "platz"));
}

export const seatCount = (cells: LayoutCells) => seatKeys(cells).length;

/**
 * Prüfungsplätze aus einem Layout: „jeder zweite Platz“ – von vorn links nach hinten rechts wird ein Platz genommen, wenn
 * links und davor (gleiche Spalte, Reihe davor) kein genommener Platz liegt. Bei der Variante „Prüfung“ zählt jeder Platz.
 */
export function examSeatKeys(cells: LayoutCells, variant: LayoutVariant): string[] {
  const seats = seatKeys(cells);
  if (variant === "pruefung") return seats;
  const taken = new Set<string>();
  for (const k of seats) {
    const { row, col } = parseCellKey(k)!;
    if (taken.has(cellKey(row, col - 1)) || taken.has(cellKey(row - 1, col))) continue;
    taken.add(k);
  }
  return [...taken];
}

/** Neues Raster einer Variante: Plätze aus der Vorlage, vorn mittig Pult und Tafel (Reihe 0 bleibt dafür frei). */
export function variantCells(variant: LayoutVariant, rows: number, cols: number): LayoutCells {
  const out: LayoutCells = {};
  if (rows < 2 || cols < 1) return out;
  const mid = Math.floor((cols - 1) / 2);
  out[cellKey(0, mid)] = "tafel";
  if (cols > 1) out[cellKey(0, cols - 1)] = "pult";
  const preset = VARIANT_PRESET[variant];
  const body = rows - 1;
  if (preset) for (const k of presetCells(preset, body, cols)) out[shift(k)] = "platz";
  else if (variant === "pruefung") for (const k of presetCells("alle", body, cols)) if (isChecker(k)) out[shift(k)] = "platz";
  return out;
}

const shift = (k: string) => {
  const p = parseCellKey(k)!;
  return cellKey(p.row + 1, p.col);
};
const isChecker = (k: string) => {
  const p = parseCellKey(k)!;
  return (p.row + p.col) % 2 === 0;
};

/** Hinweis zum Abgleich mit `rooms.capacity` – nie automatisch ändern. */
export function capacityHint(seats: number, capacity: number | null): string | null {
  if (seats === 0) return null;
  if (capacity === null) return `Im Layout sind ${seats} Plätze; in den Stammdaten ist keine Platzzahl eingetragen (Vorschlag: ${seats}).`;
  if (capacity === seats) return null;
  return `Im Layout sind ${seats} Plätze, in den Stammdaten ${capacity}. Die Platzzahl ändert die Verwaltung in den Stammdaten (Vorschlag: ${seats}).`;
}

/** Beschriftung einer Zelle für Screenreader. */
export function cellLabel(row: number, col: number, el: LayoutElement | undefined): string {
  return `Reihe ${row + 1}, Spalte ${col + 1}: ${el ? ELEMENT_LABELS[el] : "frei"}`;
}

export { MAX_COLS, MAX_ROWS };
