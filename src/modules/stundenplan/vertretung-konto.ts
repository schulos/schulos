// VT-01 (F-10-13, R9): Kontolöschung bereinigt die Historie der Vertretungen. `before/after` in `timetable_substitution_changes` haben
// keinen Fremdschlüssel auf `users`; `scrubSubstitutionChanges` ersetzt die Kennung der Vertretungslehrkraft durch den Platzhalter
// `DELETED_TEACHER` und – wie DS-21 bei den Solver-Läufen – Kürzel bzw. Name als ganzes Wort in den Hinweisen. `actor_id` leert der
// Fremdschlüssel (set null). Läuft in `deleteAccounts` (Löschung auf Antrag und Löschlauf). Bewusst ohne schwere Abhängigkeiten.
import { inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableSubstitutionChanges, users } from "@/core/db/schema";
import { DELETED_TEACHER, labelPattern } from "./solverlauf-konto";
import type { SubstitutionSnapshot } from "./vertretung-historie";

/** Kürzel/Namen als ganzes Wort ersetzen, den Platzhalter selbst nicht anfassen. */
function replaceLabels(s: string, labels: RegExp | null): string {
  if (!labels) return s;
  return s
    .split(DELETED_TEACHER)
    .map((part) => part.replace(labels, DELETED_TEACHER))
    .join(DELETED_TEACHER);
}

/** Rein: ein Historien-Stand ohne die Konten `ids` (Kennung der Vertretungslehrkraft, Kürzel/Namen in den Hinweisen). */
export function scrubSnapshot(s: SubstitutionSnapshot | null, ids: ReadonlySet<string>, labels: RegExp | null): SubstitutionSnapshot | null {
  if (!s) return s;
  return {
    ...s,
    substituteId: s.substituteId && ids.has(s.substituteId) ? DELETED_TEACHER : s.substituteId,
    note: s.note === null ? null : replaceLabels(s.note, labels),
    internalNote: s.internalNote === null || s.internalNote === undefined ? null : replaceLabels(s.internalNote, labels),
  };
}

/** Ersetzt die Konten `ids` in der Historie der Vertretungen. In der Transaktion der Kontolöschung, vor dem Löschen der Konten. */
export async function scrubSubstitutionChanges(db: Db, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  const set = new Set(ids);
  const people = await db.select({ code: users.shortCode, name: users.name }).from(users).where(inArray(users.id, [...ids]));
  const shown = people.flatMap((p) => [p.code?.trim(), p.name]).filter((x): x is string => Boolean(x));
  const labels = labelPattern(shown);
  const t = timetableSubstitutionChanges;
  const text = sql`coalesce(${t.before}::text, '') || coalesce(${t.after}::text, '')`;
  const needles = [...ids.map((id) => JSON.stringify(id)), ...shown];
  const rows = await db
    .select({ id: t.id, before: t.before, after: t.after })
    .from(t)
    .where(or(...needles.map((n) => sql`strpos(${text}, ${n}) > 0`)));
  let changed = 0;
  for (const r of rows) {
    const before = scrubSnapshot(r.before as SubstitutionSnapshot | null, set, labels);
    const after = scrubSnapshot(r.after as SubstitutionSnapshot | null, set, labels);
    if (JSON.stringify(before) === JSON.stringify(r.before) && JSON.stringify(after) === JSON.stringify(r.after)) continue;
    await db.update(t).set({ before, after }).where(sql`${t.id} = ${r.id}`);
    changed++;
  }
  return changed;
}
