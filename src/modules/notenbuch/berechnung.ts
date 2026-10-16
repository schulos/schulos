// Notenbuch (P5-10): reine Rechenlogik ohne DB – Skalen, Eingaben prüfen, Notenschlüssel (Punkte → Note je Spalte),
// Gewichtung je Spaltenart und Spalte, Rundung, Tendenz. Keine Imports (auch das Schema nutzt die Konstanten).
//
// Regeln (PHASE5-NOTENBUCH.md §4, F5-04; Entscheidungen Q-5A-1…3):
//   · Skalen: `noten6` (1–6), `noten6_tendenz` (1+ … 6, 16 Stufen = 15…0 Punkte), `punkte15` (15…0 Punkte).
//   · „fehlt“ und „befreit“ zählen nicht (weder Wert noch Gewicht). Leere Zellen ebenso.
//   · Gewichtung: je Spaltenart in % (Buch), innerhalb der Art je Spalte (Vorgabe 100 = einfach, 200 = doppelt, 0 = zählt nicht).
//     Summe ≠ 100 % ist erlaubt – es wird auf die Arten normiert, die für die Person Werte haben (Q-5A-2).
//   · Rundung auf der Grenze x,5 je Schule (Q-5A-1): Vorgabe „zugunsten der Schüler:in“ (2,5 → 2; 10,5 Punkte → 11), sonst
//     „kaufmännisch“ (2,5 → 3). Vorher wird auf 6 Stellen gerundet, damit
//     Gleitkomma-Reste (2,4999999…) nicht über die Note entscheiden.
//   · Tendenz: über die 15-Punkte-Entsprechung (1+ = 15, 1 = 14, 1− = 13, … 5− = 1, 6 = 0; Note = (17 − P) / 3, 0 P = 6).

export const SCALES = ["noten6", "noten6_tendenz", "punkte15"] as const;
export type Scale = (typeof SCALES)[number];

export const SCALE_LABELS: Record<Scale, string> = {
  noten6: "Noten 1–6",
  noten6_tendenz: "Noten 1–6 mit Tendenz (+/−)",
  punkte15: "15 Punkte (Oberstufe)",
};

export const COLUMN_KINDS = ["schriftlich", "sonstige"] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export const COLUMN_KIND_LABELS: Record<ColumnKind, string> = {
  schriftlich: "Schriftliche Arbeiten",
  sonstige: "Sonstige Leistungen",
};

export type Weights = Partial<Record<ColumnKind, number>>;

/** Vorgabe je Buch: schriftlich und sonstige Leistungen je 50 % (änderbar je Buch). */
export const DEFAULT_WEIGHTS: Record<ColumnKind, number> = { schriftlich: 50, sonstige: 50 };
/** Gewicht einer Spalte innerhalb ihrer Art (100 = einfach). */
export const COLUMN_WEIGHT_DEFAULT = 100;
export const COLUMN_WEIGHT_MAX = 1000;
export const MAX_POINTS_LIMIT = 1000;

export const SPECIAL_VALUES = ["fehlt", "befreit"] as const;
export type SpecialValue = (typeof SPECIAL_VALUES)[number];

/** Kurzkommentar je Note (F5-08): höchstens 200 Zeichen. */
export const COMMENT_MAX = 200;

const NOTEN6 = ["1", "2", "3", "4", "5", "6"] as const;
const TENDENZ = ["1+", "1", "1-", "2+", "2", "2-", "3+", "3", "3-", "4+", "4", "4-", "5+", "5", "5-", "6"] as const;
const PUNKTE = ["15", "14", "13", "12", "11", "10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0"] as const;

/** Gültige Werte einer Skala, von der besten zur schlechtesten Stufe. */
export function scaleValues(scale: Scale): readonly string[] {
  return scale === "noten6" ? NOTEN6 : scale === "noten6_tendenz" ? TENDENZ : PUNKTE;
}

/** Bei 15 Punkten ist mehr besser, bei Noten weniger. */
export function higherIsBetter(scale: Scale): boolean {
  return scale === "punkte15";
}

function tendencyNumeric(points: number): number {
  return points === 0 ? 6 : (17 - points) / 3;
}

/**
 * Umkehrung von `tendencyNumeric` (GATE-5a, G5A-C10): bis 5− (16/3) linear 17 − 3·Note, zwischen 5− und 6 stückweise
 * (5− = 1 P, 6 = 0 P) – sonst zählte der Abstand 5− → 6 wie ein Drittel und schon Ø 5,6 ergäbe „6“ statt „5−“.
 */
function tendencyPoints(note: number): number {
  const fiveMinus = 16 / 3;
  return note <= fiveMinus ? 17 - 3 * note : 1 - (note - fiveMinus) / (6 - fiveMinus);
}

/** Zahlenwert einer gültigen Stufe (Noten: 1,0…6,0, Tendenz in Dritteln; Punkte: 0…15). */
export function numericValue(scale: Scale, label: string): number {
  const values = scaleValues(scale);
  const idx = values.indexOf(label);
  if (idx < 0) throw new Error(`Ungültiger Wert „${label}“ für ${scale}`);
  if (scale === "noten6_tendenz") return tendencyNumeric(15 - idx);
  return Number(label);
}

/** Eingabe vereinheitlichen: Leerraum weg, Gedankenstrich/Minuszeichen → „-“, Komma → Punkt, Sonderwerte klein. */
export function normalizeInput(raw: string): string {
  const s = raw.trim().replace(/[−–—]/g, "-").replace(/\s+/g, "");
  const lower = s.toLowerCase();
  return (SPECIAL_VALUES as readonly string[]).includes(lower) ? lower : s.replace(",", ".");
}

// ------------------------------------------------------------------ Notenschlüssel

/** Notenschlüssel einer Spalte: ab `min` Prozent der Höchstpunktzahl gilt `grade` (absteigend, letzte Stufe ab 0 %). */
export type GradeKey = readonly { min: number; grade: string }[];

const ABITUR_PERCENT = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 33, 27, 20, 0];

/**
 * Vorgabe-Schlüssel je Skala (änderbar je Spalte): angelehnt an die Prozentgrenzen der Abiturprüfung in NRW; bei Noten 1–6
 * die zusammengefassten Stufen (1 ab 85 %, 2 ab 70 %, 3 ab 55 %, 4 ab 40 %, 5 ab 20 %). Nur ein Vorschlag (Q-5A-3).
 */
export function defaultKey(scale: Scale): GradeKey {
  if (scale === "noten6") return NOTEN6.map((grade, i) => ({ grade, min: [85, 70, 55, 40, 20, 0][i]! }));
  return scaleValues(scale).map((grade, i) => ({ grade, min: ABITUR_PERCENT[i]! }));
}

/** Prüft einen Schlüssel: nicht leer, Werte der Skala vom besten zum schlechtesten, Grenzen streng fallend, letzte 0 %. */
export function keyError(key: GradeKey, scale: Scale): string | null {
  if (key.length === 0) return "Der Notenschlüssel ist leer";
  const values = scaleValues(scale);
  let lastIdx = -1;
  let lastMin = Infinity;
  for (const step of key) {
    const idx = values.indexOf(step.grade);
    if (idx < 0) return `„${step.grade}“ ist auf dieser Skala kein gültiger Wert`;
    if (idx <= lastIdx) return "Stufen bitte von der besten zur schlechtesten ordnen, jede nur einmal";
    if (!Number.isFinite(step.min) || step.min < 0 || step.min > 100) return "Grenzen liegen zwischen 0 und 100 %";
    if (step.min >= lastMin) return "Die Grenzen müssen von oben nach unten kleiner werden";
    lastIdx = idx;
    lastMin = step.min;
  }
  if (lastMin !== 0) return "Die letzte Stufe muss bei 0 % beginnen";
  return null;
}

const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** Note zu erreichten Punkten nach dem Schlüssel (Prozent der Höchstpunktzahl, Grenze einschließlich). */
export function gradeFromPoints(points: number, maxPoints: number, key: GradeKey): string {
  const pct = round9((points / maxPoints) * 100);
  for (const step of key) if (pct >= step.min) return step.grade;
  return key.at(-1)!.grade;
}

// ------------------------------------------------------------------ Eingaben

export type ParsedEntry =
  | { kind: "grade"; label: string; value: number; points?: number }
  | { kind: SpecialValue }
  | { kind: "empty" }
  | { kind: "invalid"; error: string };

export interface ColumnSpec {
  id: string;
  kind: ColumnKind;
  /** Gewicht innerhalb der Art (100 = einfach, 0 = zählt nicht) */
  weight: number;
  /** gesetzt: Eingabe sind Punkte, die Note ergibt sich aus dem Schlüssel */
  maxPoints?: number | null;
  key?: GradeKey | null;
}

/** Prüft und deutet eine Eingabe in einer Spalte (Note der Skala bzw. erreichte Punkte bei Spalten mit Höchstpunktzahl). */
export function parseEntry(raw: string, scale: Scale, column?: Pick<ColumnSpec, "maxPoints" | "key">): ParsedEntry {
  const s = normalizeInput(raw);
  if (s === "") return { kind: "empty" };
  if (s === "fehlt" || s === "befreit") return { kind: s };
  if (column?.maxPoints) {
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return { kind: "invalid", error: "Punkte als Zahl eingeben (z. B. 23,5)" };
    const points = Number(s);
    if (points > column.maxPoints) return { kind: "invalid", error: `Höchstens ${String(column.maxPoints).replace(".", ",")} Punkte` };
    const label = gradeFromPoints(points, column.maxPoints, column.key ?? defaultKey(scale));
    return { kind: "grade", label, value: numericValue(scale, label), points };
  }
  if (!scaleValues(scale).includes(s)) {
    const hint = scale === "noten6" ? "1 bis 6" : scale === "noten6_tendenz" ? "1+ bis 6 (mit + oder −)" : "0 bis 15 Punkte";
    return { kind: "invalid", error: `Gültig sind ${hint}, „fehlt“ oder „befreit“` };
  }
  return { kind: "grade", label: s, value: numericValue(scale, s) };
}

// ------------------------------------------------------------------ Durchschnitt und Rundung

/**
 * Rundung genau auf der Grenze (Q-5A-1, Projektleitung 2026-10-14: Einstellung je Schule, Moduleinstellung `notenbuch.rounding`):
 * `schueler` (Vorgabe) = zugunsten der Schüler:in (2,5 → 2; 10,5 P → 11; Tendenz über die Punkte 12,5 → 13 = 1−);
 * `kaufmaennisch` = auf der Grenze zur größeren Zahl der angezeigten Skala (2,5 → 3; 10,5 P → 11; Tendenz in Noten: 2,5 → 3+).
 * Bei 15 Punkten sind beide gleich – mehr Punkte sind besser.
 */
export const ROUNDING_MODES = ["schueler", "kaufmaennisch"] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

/** Rundet einen Durchschnitt auf eine Stufe der Skala – auf der Grenze x,5 nach `mode` (Vorgabe zugunsten der Schüler:in). */
export function roundToScale(scale: Scale, average: number, mode: RoundingMode = "schueler"): string {
  // auf 6 Stellen: Gleitkomma-Reste (auch aus der Umrechnung Note → Punkte, × 3) entscheiden nicht über die Stufe
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const a = round6(average);
  if (scale === "noten6") return String(Math.min(6, Math.max(1, mode === "kaufmaennisch" ? Math.floor(a + 0.5) : Math.ceil(a - 0.5))));
  const points = scale === "punkte15" ? a : round6(tendencyPoints(average));
  // Tendenz kaufmännisch: Grenze in der Notenskala → zur schlechteren Stufe = weniger Punkte
  const p = Math.min(15, Math.max(0, scale === "noten6_tendenz" && mode === "kaufmaennisch" ? Math.ceil(points - 0.5) : Math.floor(points + 0.5)));
  return scale === "punkte15" ? String(p) : TENDENZ[15 - p]!;
}

export interface StudentResult {
  /** gewichteter Durchschnitt auf der Skala (ungerundet), ohne zählende Werte null */
  average: number | null;
  /** gerundete Stufe (Vorschlag der Halbjahresnote) */
  grade: string | null;
  byKind: Record<ColumnKind, number | null>;
  /** Anzahl zählender Werte */
  counted: number;
  /** Spalten mit ungültiger Eingabe (zählen nicht) */
  invalid: string[];
}

/** Prüft die Gewichte je Spaltenart: ganze Zahlen 0–100, zusammen mehr als 0. Summe ≠ 100 ist erlaubt (Q-5A-2). */
export function weightsError(weights: Weights): string | null {
  let sum = 0;
  for (const k of COLUMN_KINDS) {
    const w = weights[k] ?? 0;
    if (!Number.isInteger(w) || w < 0 || w > 100) return "Gewichte als ganze Prozentzahl von 0 bis 100 angeben";
    sum += w;
  }
  return sum > 0 ? null : "Mindestens eine Spaltenart braucht ein Gewicht";
}

/**
 * Durchschnitt und Vorschlag für eine Person. `entries`: Spalten-ID → Eingabe. Je Art der gewichtete Durchschnitt der Spalten,
 * dann über die Arten mit Werten nach den Buchgewichten (normiert). Arten ohne Werte oder mit Gewicht 0 fallen heraus.
 */
export function computeStudent(
  scale: Scale,
  weights: Weights,
  columns: readonly ColumnSpec[],
  entries: ReadonlyMap<string, string>,
  rounding: RoundingMode = "schueler",
): StudentResult {
  const sums = new Map<ColumnKind, { wv: number; w: number }>();
  const invalid: string[] = [];
  let counted = 0;
  for (const col of columns) {
    const raw = entries.get(col.id);
    if (raw === undefined) continue;
    const parsed = parseEntry(raw, scale, col);
    if (parsed.kind === "invalid") invalid.push(col.id);
    if (parsed.kind !== "grade" || !(col.weight > 0)) continue;
    const s = sums.get(col.kind) ?? { wv: 0, w: 0 };
    s.wv += col.weight * parsed.value;
    s.w += col.weight;
    sums.set(col.kind, s);
    counted++;
  }
  const byKind = Object.fromEntries(COLUMN_KINDS.map((k) => [k, sums.has(k) ? sums.get(k)!.wv / sums.get(k)!.w : null])) as Record<ColumnKind, number | null>;
  let total = 0;
  let weightSum = 0;
  for (const k of COLUMN_KINDS) {
    const avg = byKind[k];
    const w = weights[k] ?? 0;
    if (avg === null || !(w > 0)) continue;
    total += w * avg;
    weightSum += w;
  }
  const average = weightSum > 0 ? round9(total / weightSum) : null;
  return { average, grade: average === null ? null : roundToScale(scale, average, rounding), byKind, counted, invalid };
}

/** Durchschnitt zum Anzeigen, z. B. „2,33“ bzw. „10,50“. */
export function formatAverage(average: number | null): string {
  return average === null ? "–" : average.toFixed(2).replace(".", ",");
}

// ------------------------------------------------------------------ Notenspiegel (P5-12)

export interface Distribution {
  /** Anzahl je ganzer Note 1…6 (Tendenzen und 15 Punkte zusammengefasst) – ohne Namen */
  buckets: { grade: string; count: number }[];
  /** Anzahl gültiger Noten */
  count: number;
  fehlt: number;
  befreit: number;
  /** Durchschnitt auf der Skala des Buchs (ungerundet), ohne Noten null */
  average: number | null;
}

/** Ganze Note (1…6) zu einer Stufe der Skala – 15 Punkte nach der üblichen Entsprechung (13–15 = 1, …, 1–3 = 5, 0 = 6). */
export function wholeGrade(scale: Scale, label: string): string {
  if (scale === "punkte15") {
    const p = Number(label);
    return p === 0 ? "6" : String(6 - Math.ceil(p / 3));
  }
  return label.replace(/[+-]$/, "");
}

/** Notenspiegel einer Spalte aus den Eingaben (ohne Namen). Ungültige Eingaben und leere Zellen zählen nicht. */
export function distribution(scale: Scale, column: Pick<ColumnSpec, "maxPoints" | "key">, values: Iterable<string>): Distribution {
  const counts = new Map(NOTEN6.map((g) => [g as string, 0]));
  let count = 0;
  let fehlt = 0;
  let befreit = 0;
  let sum = 0;
  for (const raw of values) {
    const p = parseEntry(raw, scale, column);
    if (p.kind === "fehlt") fehlt++;
    else if (p.kind === "befreit") befreit++;
    else if (p.kind === "grade") {
      const g = wholeGrade(scale, p.label);
      counts.set(g, (counts.get(g) ?? 0) + 1);
      count++;
      sum += p.value;
    }
  }
  return { buckets: NOTEN6.map((grade) => ({ grade, count: counts.get(grade) ?? 0 })), count, fehlt, befreit, average: count ? round9(sum / count) : null };
}

/** Summe der Buchgewichte in % (Hinweis in der Tabelle, wenn ≠ 100). */
export function weightsSum(weights: Weights): number {
  return COLUMN_KINDS.reduce((s, k) => s + (weights[k] ?? 0), 0);
}
