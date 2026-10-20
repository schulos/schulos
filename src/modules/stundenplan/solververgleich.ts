// SP-08: Vergleich von 2–3 Solver-Läufen – Auswahl prüfen und Kennzahlen nebeneinander mit bestem Wert und Delta zum ersten Lauf.
// Rein (ohne Datenbank) bis auf `loadComparison`; die Kennzahlen kommen aus `metrics` (keine Diagnose je Aufruf).
import type { Db } from "@/core/db/client";
import { COST_LABELS, type CostItem } from "./solver";
import {
  listRunSummaries,
  type RunMetrics,
  type RunSummary,
} from "./solverlauf";
import { DIAGNOSIS_LABELS } from "./diagnose";

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 3;

/** Läufe mit Kennzahlen, die sich vergleichen lassen (fertig oder übernommen). */
export const COMPARABLE_STATUSES = ["done", "applied"] as const;
export const isComparable = (r: { status: string; metrics: unknown }) =>
  (COMPARABLE_STATUSES as readonly string[]).includes(r.status) &&
  r.metrics != null;

/** `laeufe=a,b,c` oder wiederholt `laeufe=a&laeufe=b` (Formular ohne Skript) → eindeutige Ids in der gegebenen Reihenfolge. */
export function parseCompareIds(raw: string | string[] | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw ?? ""]).flatMap((s) =>
    s.split(","),
  );
  return [
    ...new Set(
      parts.map((s) => s.trim()).filter((s) => /^[\w-]{1,64}$/.test(s)),
    ),
  ];
}

export interface CompareRow {
  key: string;
  label: string;
  group: "gesamt" | "hohlstunden" | "diagnose" | "kosten" | "lauf";
  /** Werte je Lauf in der Reihenfolge der Auswahl */
  values: number[];
  /** Indizes der besten Läufe (kleiner ist besser); leer, wenn alle gleich sind oder die Zeile nicht gewertet wird */
  best: number[];
  /** Unterschied zum ersten Lauf (Wert − erster Wert); beim ersten Lauf immer 0 */
  deltas: number[];
  /** Einheit der Anzeige */
  unit?: "ms";
}

export const GROUP_LABELS: Record<CompareRow["group"], string> = {
  gesamt: "Gesamtbewertung",
  hohlstunden: "Hohlstunden",
  diagnose: "Diagnose des Vorschlags",
  kosten: "Bewertung nach Kostenposten",
  lauf: "Lauf",
};

/** Delta zum ersten Wert und beste Indizes für eine Zeile. `judged=false` (z. B. Dauer): kein bester Wert. */
export function rowOf(
  key: string,
  label: string,
  group: CompareRow["group"],
  values: number[],
  judged = true,
  unit?: "ms",
): CompareRow {
  const min = Math.min(...values);
  const allEqual = values.every((v) => v === values[0]);
  return {
    key,
    label,
    group,
    values,
    best:
      judged && !allEqual
        ? values.flatMap((v, i) => (v === min ? [i] : []))
        : [],
    deltas: values.map((v) => Math.round((v - values[0]!) * 1000) / 1000),
    unit,
  };
}

/** Kennzahlen nebeneinander. Erwartet mindestens einen Lauf; alle Zeilen: kleiner ist besser (außer Dauer, nur zur Information). */
export function compareMetrics(metrics: RunMetrics[]): CompareRow[] {
  const pick = (f: (m: RunMetrics) => number) => metrics.map(f);
  const rows: CompareRow[] = [
    rowOf(
      "score",
      "Bewertung",
      "gesamt",
      pick((m) => m.score ?? 0),
    ),
    rowOf(
      "unplaced",
      "Nicht gesetzte Einheiten",
      "gesamt",
      pick((m) => m.unplaced ?? 0),
    ),
    rowOf(
      "teacherTotal",
      "Hohlstunden Lehrkräfte (gesamt)",
      "hohlstunden",
      pick((m) => m.gaps?.teacherTotal ?? 0),
    ),
    rowOf(
      "teacherMax",
      "Hohlstunden Lehrkräfte (höchstens je Lehrkraft)",
      "hohlstunden",
      pick((m) => m.gaps?.teacherMax ?? 0),
    ),
    rowOf(
      "classTotal",
      "Hohlstunden Klassen (gesamt)",
      "hohlstunden",
      pick((m) => m.gaps?.classTotal ?? 0),
    ),
    rowOf(
      "classMax",
      "Hohlstunden Klassen (höchstens je Klasse)",
      "hohlstunden",
      pick((m) => m.gaps?.classMax ?? 0),
    ),
    ...(["gaps", "subjectDay", "room"] as const).map((c) =>
      rowOf(
        `diag-${c}`,
        DIAGNOSIS_LABELS[c],
        "diagnose",
        pick((m) => m.diag?.[c] ?? 0),
      ),
    ),
    ...(Object.keys(COST_LABELS) as CostItem["category"][]).map((c) =>
      rowOf(
        `cost-${c}`,
        COST_LABELS[c],
        "kosten",
        pick((m) => m.breakdown?.[c] ?? 0),
      ),
    ),
    rowOf(
      "duration",
      "Dauer",
      "lauf",
      pick((m) => m.durationMs ?? 0),
      false,
      "ms",
    ),
  ];
  return rows;
}

export interface Comparison {
  runs: RunSummary[];
  rows: CompareRow[];
}

export type ComparisonResult =
  { ok: true; comparison: Comparison } | { ok: false; problem: string };

/**
 * Läufe laden und prüfen: 2–3 verschiedene, vorhandene, fertige Läufe desselben Schuljahres mit Kennzahlen.
 * Reihenfolge wie in der Auswahl (der erste ist die Bezugsgröße für die Deltas).
 */
export async function loadComparison(
  db: Db,
  ids: string[],
): Promise<ComparisonResult> {
  if (ids.length < MIN_COMPARE)
    return {
      ok: false,
      problem: `Für den Vergleich braucht es mindestens ${MIN_COMPARE} Läufe.`,
    };
  if (ids.length > MAX_COMPARE)
    return {
      ok: false,
      problem: `Verglichen werden höchstens ${MAX_COMPARE} Läufe.`,
    };
  const found = await listRunSummaries(db, { ids });
  const byId = new Map(found.map((r) => [r.id, r]));
  const runs = ids.map((id) => byId.get(id));
  if (runs.some((r) => !r))
    return {
      ok: false,
      problem:
        "Mindestens ein Lauf wurde nicht gefunden (vielleicht gelöscht).",
    };
  const list = runs as RunSummary[];
  if (list.some((r) => !isComparable(r)))
    return {
      ok: false,
      problem: "Verglichen werden nur fertige oder übernommene Läufe.",
    };
  if (new Set(list.map((r) => r.schoolYearId)).size > 1)
    return {
      ok: false,
      problem: "Die Läufe gehören zu verschiedenen Schuljahren.",
    };
  return {
    ok: true,
    comparison: {
      runs: list,
      rows: compareMetrics(list.map((r) => r.metrics!)),
    },
  };
}
