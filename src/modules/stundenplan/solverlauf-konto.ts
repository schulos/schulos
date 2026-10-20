// SP-14 (Q-SP-9-2, Projektleitung 2026-10-20): Kontolöschung bereinigt Lehrkraft-Kennungen in Solver-Läufen. Die JSON-Felder
// `params`, `result`, `undo` und `log` haben keinen Fremdschlüssel auf `users`; beim Löschen eines Kontos ersetzt `scrubSolverRuns`
// jede Kennung des Kontos (als Wert oder Schlüssel) durch den Platzhalter `DELETED_TEACHER`. Bewusst ohne schwere Abhängigkeiten,
// weil die Kontolöschung (`src/core/privacy/konto.ts`) es aufruft.
import { or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableSolverRuns } from "@/core/db/schema";

/** Platzhalter für die Kennung einer gelöschten Lehrkraft in Solver-Läufen – zugleich ihre Anzeige. */
export const DELETED_TEACHER = "gelöschte Lehrkraft";

/** Rein: ersetzt Kennungen aus `ids` (als Zeichenkette oder Objektschlüssel) überall in einem JSON-Wert durch den Platzhalter. */
export function scrubIds(value: unknown, ids: ReadonlySet<string>): unknown {
  if (typeof value === "string") return ids.has(value) ? DELETED_TEACHER : value;
  if (Array.isArray(value)) return value.map((v) => scrubIds(v, ids));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.has(k) ? DELETED_TEACHER : k, scrubIds(v, ids)]));
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
  const t = timetableSolverRuns;
  const text = sql`coalesce(${t.params}::text, '') || coalesce(${t.result}::text, '') || coalesce(${t.undo}::text, '') || coalesce(${t.log}::text, '')`;
  // Vorauswahl per Textsuche (JSON-Zeichenkette mit Anführungszeichen), die genaue Prüfung macht `scrubIds`
  const rows = await db
    .select({ id: t.id, params: t.params, result: t.result, undo: t.undo, log: t.log })
    .from(t)
    .where(or(...ids.map((id) => sql`${text} like ${`%${JSON.stringify(id)}%`}`)));
  let changed = 0;
  for (const r of rows) {
    const patch: Partial<Record<(typeof FIELDS)[number], unknown>> = {};
    for (const f of FIELDS) {
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
