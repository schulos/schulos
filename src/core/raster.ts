// Gemeinsames Raster für Sitzplan (P5-01/P5-02) und Raumlayout (RS-08): Größe, Zellschlüssel, Vorlagen und
// Tastaturbewegung – rein, ohne Datenbank und ohne Abhängigkeiten (auch in Client-Komponenten nutzbar).
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

export const cellKey = (row: number, col: number) => `${row}:${col}`;

export function parseCellKey(key: string): { row: number; col: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(key);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
}

/** Felder einer Vorlage im Raster `rows` × `cols`, sortiert von vorn links nach hinten rechts. */
export function presetCells(preset: Preset, rows: number, cols: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const desk =
        preset === "alle" ||
        (preset === "reihen" && c % 3 !== 2) ||
        (preset === "gruppen" && r % 3 !== 2 && c % 3 !== 2) ||
        (preset === "u-form" && (c === 0 || c === cols - 1 || r === rows - 1));
      if (desk) out.push(cellKey(r, c));
    }
  return out;
}

/** Zellschlüssel in Lesereihenfolge (vorn links zuerst). */
export function sortCells(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => {
    const x = parseCellKey(a)!;
    const y = parseCellKey(b)!;
    return x.row - y.row || x.col - y.col;
  });
}

/** Rasterprüfung: Fehlermeldung oder null. */
export function sizeError(rows: number, cols: number, colsLabel = "Plätze je Reihe"): string | null {
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) return `Reihen: 1 bis ${MAX_ROWS}`;
  if (!Number.isInteger(cols) || cols < 1 || cols > MAX_COLS) return `${colsLabel}: 1 bis ${MAX_COLS}`;
  return null;
}

/** Pfeiltaste → Richtung im Raster (oder null für andere Tasten). */
export function arrowDelta(key: string): [number, number] | null {
  const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  return d[key] ?? null;
}
