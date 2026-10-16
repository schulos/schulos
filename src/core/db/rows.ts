/**
 * Zeilen aus `db.execute()` – PGlite liefert `{ rows }`, postgres-js ein Array.
 * Immer diesen Helfer nutzen, nie `.rows` direkt (sonst läuft es nur unter PGlite).
 */
export function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}
