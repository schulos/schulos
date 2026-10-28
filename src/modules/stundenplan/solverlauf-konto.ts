// SP-14 (Q-SP-9-2, Projektleitung 2026-10-20): Kontolöschung bereinigt Lehrkraft-Kennungen in Solver-Läufen. Die JSON-Felder
// `params`, `result`, `undo` und `log` haben keinen Fremdschlüssel auf `users`; beim Löschen eines Kontos ersetzt `scrubSolverRuns`
// jede Kennung des Kontos (als Wert oder Schlüssel) durch den Platzhalter `DELETED_TEACHER`. DS-21: ebenso Kürzel bzw. Name der
// Lehrkraft in Texten des Laufs (Kostenposten, Gründe „nicht gesetzt“, Vorprüfung, Protokoll) – als ganzes Wort. R2-P1: strukturelle
// Kennungen (Fach, Raum, Gruppe, Stunde …) bleiben dabei immer unverändert (`STRUCTURAL_KEYS`). Bewusst ohne schwere Abhängigkeiten,
// weil die Kontolöschung (`src/core/privacy/konto.ts`) es aufruft.
import { inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetablePlanChanges, timetablePlanVersions, timetableSolverRuns, users } from "@/core/db/schema";

/** Platzhalter für die Kennung einer gelöschten Lehrkraft in Solver-Läufen – zugleich ihre Anzeige. */
export const DELETED_TEACHER = "gelöschte Lehrkraft";

/** Rein: Muster für Kürzel/Namen als ganzes Wort (nicht Teil eines längeren Worts oder Kürzels); `null` ohne Kürzel. */
export function labelPattern(labels: readonly (string | null | undefined)[]): RegExp | null {
  const list = [...new Set(labels.map((l) => l?.trim()).filter((l): l is string => Boolean(l)))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const alt = list.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * R2-P1: Felder mit strukturellen Kennungen (Fach, Raum, Gruppe, Stunde, Einheit, Lehrauftrag, Kopplung, Zeit) – sie bleiben bei der
 * Bereinigung immer unverändert, auch wenn ein Kürzel oder eine Kennung zufällig gleich lautet (Lehrkraft „MU“, Fach „MU“, Raum „MU“).
 * Sonst scheitert die Übernahme an Fremdschlüsseln bzw. das Zurücknehmen verwirft Stunden.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "subjectId",
  "subjectIds",
  "roomId",
  "roomIds",
  "homeRoomId",
  "roomKind",
  "groupId",
  "groupIds",
  "unitId",
  "assignmentId",
  "lessonId",
  "keptLessonIds",
  "couplingId",
  "bandId",
  "solverRunId",
  "schoolYearId",
  "refYmd",
  "from",
  "to",
  "date",
  "week",
  "weekday",
  "periodNr",
  "validFrom",
  "validUntil",
  "kind",
  "severity",
  "category",
  "at",
  "status",
  "preset",
  "effort",
  "createdAt",
]);

/**
 * R2-P1: Felder, die nur Kennungen tragen (Lehrkraft, Konto, Einheit/Stunde) – dort wird nur eine ganze Kennung ersetzt, nie ein Kürzel
 * als Wortteil (sonst würde aus der Kennung „u-x.MU“ einer anderen Lehrkraft „u-x.gelöschte Lehrkraft“).
 */
const ID_KEYS: ReadonlySet<string> = new Set(["id", "teacherId", "teacherIds", "substituteId", "createdBy", "appliedBy", "teacher", "teachers"]);

/** Kürzel/Namen als ganzes Wort ersetzen – ohne den Platzhalter selbst anzufassen (schon bereinigte Altbestände bleiben stabil). */
function replaceLabels(s: string, labels: RegExp): string {
  return s
    .split(DELETED_TEACHER)
    .map((part) => part.replace(labels, DELETED_TEACHER))
    .join(DELETED_TEACHER);
}

/**
 * Rein: ersetzt Kennungen aus `ids` (als Zeichenkette oder Objektschlüssel) in einem JSON-Wert durch den Platzhalter; mit `labels`
 * (DS-21) zusätzlich Kürzel/Namen als ganzes Wort in Texten (Bezeichnung, Grund, Kostenposten, Protokoll, Hinweis). R2-P1: Werte
 * unter strukturellen Schlüsseln (`STRUCTURAL_KEYS`) bleiben unverändert, unter Kennungs-Schlüsseln (`ID_KEYS`) zählt nur die ganze
 * Kennung; Objektschlüssel werden nur als ganze Kennung ersetzt (Zählungen je Lehrkraft). Arrays erben den Schlüssel ihres Felds.
 */
export function scrubIds(value: unknown, ids: ReadonlySet<string>, labels: RegExp | null = null, key: string | null = null): unknown {
  if (key !== null && STRUCTURAL_KEYS.has(key)) return value;
  if (typeof value === "string") {
    if (ids.has(value)) return DELETED_TEACHER;
    if (!labels || (key !== null && ID_KEYS.has(key))) return value;
    return replaceLabels(value, labels);
  }
  if (Array.isArray(value)) return value.map((v) => scrubIds(v, ids, labels, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.has(k) ? DELETED_TEACHER : k, scrubIds(v, ids, labels, k)]));
  return value;
}

/** Anzeige einer Lehrkraft-Kennung aus einem Lauf: Kürzel/Name, Platzhalter für gelöschte, sonst nichts. */
export function runTeacherLabel(codes: ReadonlyMap<string, string>, id: string | null): string | null {
  if (!id) return null;
  return codes.get(id) ?? (id === DELETED_TEACHER ? DELETED_TEACHER : null);
}

const FIELDS = ["params", "result", "undo", "log"] as const;

/**
 * Ersetzt die Kennungen der Konten `ids` in allen Solver-Läufen (`params`, `result`, `undo`, `log`) durch den Platzhalter.
 * Läuft in der Transaktion der Kontolöschung, vor dem Löschen der Konten. Gibt die Zahl der geänderten Läufe zurück.
 */
export async function scrubSolverRuns(db: Db, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const set = new Set(ids);
  // DS-21: Kürzel bzw. Name (Anzeige im Lauf: Kürzel, sonst Name) – vor dem Löschen der Konten gelesen
  const people = await db.select({ code: users.shortCode, name: users.name }).from(users).where(inArray(users.id, [...ids]));
  const shown = people.map((p) => p.code?.trim() || p.name);
  const labels = labelPattern(shown);
  const t = timetableSolverRuns;
  const text = sql`coalesce(${t.params}::text, '') || coalesce(${t.result}::text, '') || coalesce(${t.undo}::text, '') || coalesce(${t.log}::text, '')`;
  // Vorauswahl per Textsuche (Kennung als JSON-Zeichenkette, Kürzel als Teiltext), die genaue Prüfung macht `scrubIds`
  const needles = [...ids.map((id) => JSON.stringify(id)), ...shown.filter(Boolean)];
  const rows = await db
    .select({ id: t.id, params: t.params, result: t.result, undo: t.undo, log: t.log })
    .from(t)
    .where(or(...needles.map((n) => sql`strpos(${text}, ${n}) > 0`)));
  let changed = 0;
  for (const r of rows) {
    const patch: Partial<Record<(typeof FIELDS)[number], unknown>> = {};
    for (const f of FIELDS) {
      if (r[f] === null || r[f] === undefined) continue;
      const next = scrubIds(r[f], set, labels);
      if (JSON.stringify(next) !== JSON.stringify(r[f])) patch[f] = next;
    }
    if (!Object.keys(patch).length) continue;
    await db.update(t).set(patch).where(sql`${t.id} = ${r.id}`);
    changed++;
  }
  return changed;
}

/**
 * SP3-04 (§5 Querschnitt d): dieselbe Bereinigung für Planversionen – Rücknahme-Daten der Veröffentlichung (`undo`: Stunden mit Lehrkraft,
 * Vertretungen, Material) und die noch nicht versandte Änderungsliste (`notify`: Kürzel in den Zeilen). Das Zurücknehmen behandelt den
 * Platzhalter wie eine gelöschte Lehrkraft (Stunde bzw. Vertretung ohne Lehrkraft). SP3-06: ebenso die Fahrplan-Checkliste (`checklist`).
 * Gibt die Zahl der geänderten Versionen zurück.
 */
export async function scrubPlanVersions(db: Db, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const set = new Set(ids);
  const people = await db.select({ code: users.shortCode, name: users.name }).from(users).where(inArray(users.id, [...ids]));
  const shown = people.map((p) => p.code?.trim() || p.name);
  const labels = labelPattern(shown);
  const t = timetablePlanVersions;
  const text = sql`coalesce(${t.undo}::text, '') || coalesce(${t.notify}::text, '') || coalesce(${t.checklist}::text, '')`;
  const needles = [...ids.map((id) => JSON.stringify(id)), ...shown.filter(Boolean)];
  const rows = await db
    .select({ id: t.id, undo: t.undo, notify: t.notify, checklist: t.checklist })
    .from(t)
    .where(or(...needles.map((n) => sql`strpos(${text}, ${n}) > 0`)));
  let changed = 0;
  for (const r of rows) {
    const patch: { undo?: unknown; notify?: unknown; checklist?: unknown } = {};
    // SP3-06: Fahrplan-Checkliste – Quittierungen nennen die Lehrkraft einer Warnung (`teacherId`), wer quittiert/abgehakt hat
    // (`createdBy`) und eine Begründung (Kürzel/Namen als ganzes Wort)
    for (const f of ["undo", "notify", "checklist"] as const) {
      if (r[f] === null || r[f] === undefined) continue;
      const next = scrubIds(r[f], set, labels);
      if (JSON.stringify(next) !== JSON.stringify(r[f])) patch[f] = next;
    }
    if (!Object.keys(patch).length) continue;
    await db.update(t).set(patch).where(sql`${t.id} = ${r.id}`);
    changed++;
  }
  return changed;
}

/**
 * SP3-05 (§5 Querschnitt d, F-10-13): Protokoll der Sofort-Korrekturen – Vorher/Nachher (`before`/`after`) enthalten Lehrkraft-Kennungen;
 * sie werden durch den Platzhalter ersetzt („Handelnde:r“ leert der Fremdschlüssel). Gibt die Zahl der geänderten Zeilen zurück.
 */
export async function scrubPlanChanges(db: Db, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const set = new Set(ids);
  const t = timetablePlanChanges;
  const text = sql`coalesce(${t.before}::text, '') || coalesce(${t.after}::text, '')`;
  const rows = await db
    .select({ id: t.id, before: t.before, after: t.after })
    .from(t)
    .where(or(...ids.map((id) => sql`strpos(${text}, ${JSON.stringify(id)}) > 0`)));
  let changed = 0;
  for (const r of rows) {
    const patch: { before?: unknown; after?: unknown } = {};
    for (const f of ["before", "after"] as const) {
      if (r[f] === null || r[f] === undefined) continue;
      const next = scrubIds(r[f], set);
      if (JSON.stringify(next) !== JSON.stringify(r[f])) patch[f] = next;
    }
    if (!Object.keys(patch).length) continue;
    await db.update(t).set(patch).where(sql`${t.id} = ${r.id}`);
    changed++;
  }
  return changed;
}
