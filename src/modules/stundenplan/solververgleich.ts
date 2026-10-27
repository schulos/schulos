// SP-08: Vergleich von 2–3 Solver-Läufen – Auswahl prüfen und Kennzahlen nebeneinander mit bestem Wert und Delta zum ersten Lauf.
// Rein (ohne Datenbank) bis auf `loadComparison`; die Kennzahlen kommen aus `metrics` (keine Diagnose je Aufruf).
// SP3-02: zweite Quelle „Version“ – Variantenvergleich von Entwürfen/Versionen mit Kennzahlen aus ihrem Wochenplan (`loadVersionComparison`).
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groups, periods, schoolYears } from "@/core/db/schema";
import { COST_LABELS, type CostItem } from "./solver";
import {
  listRunSummaries,
  type RunMetrics,
  type RunSummary,
} from "./solverlauf";
import { DIAGNOSIS_LABELS, diagnoseYear, gapsOf, type Finding } from "./diagnose";
import { diffLessons, versionSide } from "./plan-diff";
import { getVersion, versionNumber } from "./planversionen";
import type { TimetablePlanVersion } from "./schema";

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

// ---------------------------------------------------------------- Variantenvergleich (SP3-02, §2.5)

/** Kennzahlen eines Wochenplans (Version) für den Variantenvergleich. */
export interface PlanMetrics {
  lessons: number;
  withoutTeacher: number;
  gaps: { teacherTotal: number; teacherMax: number; classTotal: number; classMax: number };
  /** Diagnose-Zähler (Fehler + Warnungen) der Kategorien des Solver-Vergleichs */
  diag: Record<"gaps" | "subjectDay" | "room", number>;
  errors: number;
  warnings: number;
}

/** Rein: Hohlstunden je Lehrkraft und Klasse (je Tag zwischen erster und letzter Stunde; A/B-Wochen zählen wie jede Woche). */
export function planGaps(
  lessons: readonly { groupId: string; teacherId: string | null; weekday: number; periodNr: number }[],
  periodNrs: number[],
  classIds: ReadonlySet<string>,
): PlanMetrics["gaps"] {
  const count = (key: (l: (typeof lessons)[number]) => string | null) => {
    const days = new Map<string, { id: string; periods: Set<number> }>();
    for (const l of lessons) {
      const id = key(l);
      if (!id) continue;
      const d = `${id}|${l.weekday}`;
      const entry = days.get(d) ?? { id, periods: new Set<number>() };
      entry.periods.add(l.periodNr);
      days.set(d, entry);
    }
    const per = new Map<string, number>();
    for (const { id, periods: ps } of days.values()) per.set(id, (per.get(id) ?? 0) + gapsOf(ps, periodNrs).length);
    const values = [...per.values()];
    return { total: values.reduce((s, x) => s + x, 0), max: Math.max(0, ...values) };
  };
  const t = count((l) => l.teacherId);
  const c = count((l) => (classIds.has(l.groupId) ? l.groupId : null));
  return { teacherTotal: t.total, teacherMax: t.max, classTotal: c.total, classMax: c.max };
}

/** Rein: Zeilen des Variantenvergleichs (kleiner ist besser; Wochenstunden nur zur Information). */
export function compareVersionMetrics(metrics: PlanMetrics[]): CompareRow[] {
  const pick = (f: (m: PlanMetrics) => number) => metrics.map(f);
  return [
    rowOf("lessons", "Wochenstunden", "gesamt", pick((m) => m.lessons), false),
    rowOf("withoutTeacher", "Stunden ohne Lehrkraft", "gesamt", pick((m) => m.withoutTeacher)),
    rowOf("errors", "Diagnose: Fehler", "gesamt", pick((m) => m.errors)),
    rowOf("warnings", "Diagnose: Warnungen", "gesamt", pick((m) => m.warnings)),
    rowOf("teacherTotal", "Hohlstunden Lehrkräfte (gesamt)", "hohlstunden", pick((m) => m.gaps.teacherTotal)),
    rowOf("teacherMax", "Hohlstunden Lehrkräfte (höchstens je Lehrkraft)", "hohlstunden", pick((m) => m.gaps.teacherMax)),
    rowOf("classTotal", "Hohlstunden Klassen (gesamt)", "hohlstunden", pick((m) => m.gaps.classTotal)),
    rowOf("classMax", "Hohlstunden Klassen (höchstens je Klasse)", "hohlstunden", pick((m) => m.gaps.classMax)),
    ...(["gaps", "subjectDay", "room"] as const).map((c) => rowOf(`diag-${c}`, DIAGNOSIS_LABELS[c], "diagnose", pick((m) => m.diag[c]))),
  ];
}

export interface VersionColumn {
  id: string;
  label: string;
  name: string;
  status: TimetablePlanVersion["status"];
  /** Tag, an dem der Wochenplan verglichen wird */
  refYmd: string;
}

export type VersionComparisonResult = { ok: true; versions: VersionColumn[]; rows: CompareRow[] } | { ok: false; problem: string };

/**
 * Variantenvergleich (Quelle „Version“, §2.5): 2–3 Versionen desselben Schuljahrs – Entwürfe an ihrem Stichtag, veröffentlichte wie in der
 * Versionsliste – mit Kennzahlen aus ihrem Wochenplan und der Diagnose gegen die jeweilige Quelle. Reihenfolge wie in der Auswahl
 * (die erste ist die Bezugsgröße für die Deltas).
 */
export async function loadVersionComparison(db: Db, ids: string[], todayYmd: string, fallbackObligation: number): Promise<VersionComparisonResult> {
  if (ids.length < MIN_COMPARE) return { ok: false, problem: `Für den Vergleich braucht es mindestens ${MIN_COMPARE} Versionen.` };
  if (ids.length > MAX_COMPARE) return { ok: false, problem: `Verglichen werden höchstens ${MAX_COMPARE} Versionen.` };
  const versions = await Promise.all(ids.map((id) => getVersion(db, id)));
  if (versions.some((v) => !v)) return { ok: false, problem: "Mindestens eine Version wurde nicht gefunden (vielleicht gelöscht)." };
  const list = versions as TimetablePlanVersion[];
  if (new Set(list.map((v) => v.schoolYearId)).size > 1) return { ok: false, problem: "Die Versionen gehören zu verschiedenen Schuljahren." };
  if (list.some((v) => v.status === "verworfen")) return { ok: false, problem: "Verworfene Versionen lassen sich nicht vergleichen." };
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.id, list[0]!.schoolYearId));
  if (!year) return { ok: false, problem: "Das Schuljahr gibt es nicht mehr." };
  const [periodRows, classRows] = await Promise.all([
    db.select({ nr: periods.nr }).from(periods).orderBy(periods.nr),
    db.select({ id: groups.id }).from(groups).where(eq(groups.kind, "klasse")),
  ]);
  const periodNrs = periodRows.map((p) => p.nr);
  const classIds = new Set(classRows.map((g) => g.id));
  const columns: VersionColumn[] = [];
  const metrics: PlanMetrics[] = [];
  for (const v of list) {
    const side = versionSide(v, todayYmd);
    const lessons = await diffLessons(db, side);
    const report = await diagnoseYear(db, year, side.refYmd, fallbackObligation, undefined, { source: side.source });
    const sev = (c: Finding["category"]) => report.counts[c].error + report.counts[c].warn;
    metrics.push({
      lessons: lessons.length,
      withoutTeacher: lessons.filter((l) => l.teacherId === null).length,
      gaps: planGaps(lessons, periodNrs, classIds),
      diag: { gaps: sev("gaps"), subjectDay: sev("subjectDay"), room: sev("room") },
      errors: report.findings.filter((f) => f.severity === "error").length,
      warnings: report.findings.filter((f) => f.severity === "warn").length,
    });
    columns.push({ id: v.id, label: versionNumber(v), name: v.name, status: v.status, refYmd: report.refYmd });
  }
  return { ok: true, versions: columns, rows: compareVersionMetrics(metrics) };
}
