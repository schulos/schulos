// Wo eine Person in der Datenbank vorkommt: Fremdschlüssel auf users (per Introspektion) plus wenige Verweise ohne
// Fremdschlüssel. Grundlage für Kontolöschung (B-02) und Auskunft (B-03) – neue Tabellen sind automatisch erfasst.
import { is, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/core/db/schema";

export interface UserRef {
  table: string;
  column: string;
  /** cascade: Zeile geht mit dem Konto · set null: bleibt ohne Namen · keep: bleibt unverändert (z. B. Audit-Log) */
  onDelete: "cascade" | "set null" | "keep";
  /** zusätzliche SQL-Bedingung (Teilmenge der Tabelle) */
  where?: string;
}

/** Verweise ohne Fremdschlüssel – jede neue generische „target_id“-Spalte mit Personen gehört hier hinein. */
export const SOFT_REFS: UserRef[] = [
  { table: "timetable_time_prefs", column: "target_id", where: "kind = 'teacher'", onDelete: "cascade" },
  // wird nach Ablauf pseudonymisiert (B-06), nicht mit dem Konto gelöscht – Nachweis der Rechtmäßigkeit
  { table: "audit_log", column: "target", onDelete: "keep" },
];

let cache: UserRef[] | undefined;

/** Alle Verweise auf ein Konto (ohne users selbst). */
export function userRefs(): UserRef[] {
  if (cache) return cache;
  const out: UserRef[] = [];
  for (const v of Object.values(schema) as unknown[]) {
    if (!is(v, PgTable)) continue;
    const cfg = getTableConfig(v);
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      if (getTableConfig(ref.foreignTable).name !== "users" || ref.columns.length !== 1) continue;
      out.push({ table: cfg.name, column: ref.columns[0]!.name, onDelete: fk.onDelete === "cascade" ? "cascade" : "set null" });
    }
  }
  cache = [...out, ...SOFT_REFS];
  return cache;
}

export const qid = (name: string) => sql.raw(`"${name.replace(/"/g, "")}"`);

/** Bedingung „Zeile verweist auf diese Person“ für einen Verweis. */
export function refWhere(r: UserRef, userId: string): SQL {
  const base = sql`${qid(r.column)} = ${userId}`;
  return r.where ? sql`${base} and (${sql.raw(r.where)})` : base;
}
