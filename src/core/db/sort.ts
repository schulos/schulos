import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** Deutsch sortieren (TD-01, Collation aus Migration 0038): `orderBy(de(users.lastName))` – ä bei a statt hinter z. */
export function de(column: AnyColumn | SQL): SQL {
  return sql`${column} collate "schulos_de"`;
}
