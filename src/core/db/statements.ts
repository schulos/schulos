// Abfragestatistik (B-51): pg_stat_statements im Server-Postgres (compose.yaml lädt die Bibliothek vor) → „langsame Abfragen“
// unter Verwaltung → System. Konstanten in den Abfragen ersetzt Postgres durch $1, $2 … – keine Personendaten im Text.
// PGlite (Entwicklung, Tests) bzw. Postgres ohne die Bibliothek: nichts anzeigen.
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { rowsOf } from "./rows";

export type SlowQuery = { query: string; calls: number; totalMs: number; meanMs: number; rows: number };
export type QueryStats = { since: Date | null; queries: SlowQuery[] };

/**
 * Legt die Erweiterung an, wenn Postgres die Bibliothek geladen hat. false = nicht verfügbar (PGlite, ohne Vorladen).
 * SEC-07: Im Server-Postgres legt sie das Init-Skript (bzw. die Umstellung alter Installationen) als Wartungsrolle an –
 * die App-Rolle ohne Superuser-Recht sieht `shared_preload_libraries` in pg_settings gar nicht (GUC_SUPERUSER_ONLY) und
 * dürfte die Erweiterung auch nicht anlegen. Darum zuerst: gibt es sie schon, und liefert die Sicht Zeilen (Bibliothek geladen)?
 */
export async function enableQueryStats(db: Db): Promise<boolean> {
  try {
    const [ext] = rowsOf<{ ok: number }>(await db.execute(sql`select 1 as ok from pg_extension where extname = 'pg_stat_statements'`));
    if (!ext) {
      const [lib] = rowsOf<{ setting: string }>(await db.execute(sql`select setting from pg_settings where name = 'shared_preload_libraries'`));
      if (!(lib?.setting ?? "").split(",").some((s) => s.trim() === "pg_stat_statements")) return false;
      await db.execute(sql`create extension if not exists pg_stat_statements`);
    }
    // scheitert, wenn die Bibliothek nicht vorgeladen ist („must be loaded via shared_preload_libraries“)
    await db.execute(sql`select 1 from pg_stat_statements limit 1`);
    return true;
  } catch {
    return false;
  }
}

/** Abfrage auf eine Zeile, höchstens `max` Zeichen. */
export function shortQuery(query: string, max = 300): string {
  const one = query.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Die Abfragen dieser Datenbank mit der meisten Gesamtzeit; null, wenn pg_stat_statements fehlt. */
export async function slowQueries(db: Db, limit = 10): Promise<QueryStats | null> {
  try {
    const rows = rowsOf<{ query: string; calls: string | number; total: number; mean: number; rows: string | number }>(
      await db.execute(sql`
        select s.query, s.calls, s.total_exec_time as total, s.mean_exec_time as mean, s.rows
        from pg_stat_statements s join pg_database d on d.oid = s.dbid
        where d.datname = current_database() and s.query not ilike '%pg_stat_statements%'
          -- GATE-031 (S-03): Rollen-Befehle mit Passwort (Init-Skript, Umstellung, Notfall-Rückweg) nie anzeigen
          and s.query not ilike '%password%'
        order by s.total_exec_time desc
        limit ${limit}`),
    );
    const [info] = rowsOf<{ stats_reset: string | Date | null }>(await db.execute(sql`select stats_reset from pg_stat_statements_info`));
    return {
      since: info?.stats_reset ? new Date(info.stats_reset) : null,
      queries: rows.map((r) => ({ query: shortQuery(r.query), calls: Number(r.calls), totalMs: Number(r.total), meanMs: Number(r.mean), rows: Number(r.rows) })),
    };
  } catch {
    return null;
  }
}

/**
 * GATE-031 (C-01): Läuft die App noch mit Superuser-Recht? Bei Installationen bis v0.3.1 stellt erst ein neues schulosctl
 * die Datenbankrolle um (SEC-07) – solange zeigt Verwaltung → System einen Hinweis. Nur Server-Postgres (in PGlite ist die
 * Sitzung immer Superuser); bei Fehlern false (kein Fehlalarm).
 */
export async function appRoleIsSuperuser(db: Db): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const [r] = rowsOf<{ su: boolean | string }>(await db.execute(sql`select rolsuper as su from pg_roles where rolname = current_user`));
    return r?.su === true || r?.su === "t";
  } catch {
    return false;
  }
}
