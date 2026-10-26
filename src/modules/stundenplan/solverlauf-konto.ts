// SP-14 (Q-SP-9-2, Projektleitung 2026-10-20): Kontolöschung bereinigt Lehrkraft-Kennungen in Solver-Läufen. Die JSON-Felder
// `params`, `result`, `undo` und `log` haben keinen Fremdschlüssel auf `users`; beim Löschen eines Kontos ersetzt `scrubSolverRuns`
// jede Kennung des Kontos (als Wert oder Schlüssel) durch den Platzhalter `DELETED_TEACHER`. DS-21: ebenso Kürzel bzw. Name der
// Lehrkraft in Texten des Laufs (Kostenposten, Gründe „nicht gesetzt“, Vorprüfung, Protokoll) – als ganzes Wort. Bewusst ohne schwere Abhängigkeiten,
// weil die Kontolöschung (`src/core/privacy/konto.ts`) es aufruft.
import { inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableSolverRuns, users } from "@/core/db/schema";

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
 * Rein: ersetzt Kennungen aus `ids` (als Zeichenkette oder Objektschlüssel) überall in einem JSON-Wert durch den Platzhalter;
 * mit `labels` (DS-21) zusätzlich Kürzel/Namen als ganzes Wort in jeder Zeichenkette.
 */
export function scrubIds(value: unknown, ids: ReadonlySet<string>, labels: RegExp | null = null): unknown {
  const str = (s: string) => (ids.has(s) ? DELETED_TEACHER : labels ? s.replace(labels, DELETED_TEACHER) : s);
  if (typeof value === "string") return str(value);
  if (Array.isArray(value)) return value.map((v) => scrubIds(v, ids, labels));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [str(k), scrubIds(v, ids, labels)]));
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
