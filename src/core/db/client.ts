import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export { rowsOf } from "./rows";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DbHandle {
  db: Db;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

export const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

/**
 * Öffnet eine Datenbank.
 * - `url` beginnt mit postgres:// → echter Postgres-Server (Homelab)
 * - sonst PGlite: `dataDir` = Ordner auf der Platte, ohne `dataDir` = In-Memory (Tests)
 */
export function openDb(opts: { url?: string; dataDir?: string; max?: number } = {}): DbHandle {
  if (opts.url && /^postgres(ql)?:\/\//.test(opts.url)) {
    // Pool (B-51): ein Node-Prozess braucht selten mehr als 10 Verbindungen (Postgres erlaubt 100); anpassen über SCHULOS_DB_POOL
    const client = postgres(opts.url, { max: opts.max ?? (Number(process.env.SCHULOS_DB_POOL) || 10), onnotice: () => {} });
    const db = drizzlePostgres(client, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migratePostgres(db, { migrationsFolder: MIGRATIONS_DIR }),
      close: () => client.end(),
    };
  }
  if (opts.dataDir) mkdirSync(path.dirname(opts.dataDir), { recursive: true });
  const client = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  const db = drizzlePglite(client, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_DIR }),
    close: () => client.close(),
  };
}

// Singleton für die App. Über globalThis, damit Hot-Reload im Dev-Server
// keine zweite PGlite-Instanz auf denselben Ordner öffnet.
const globalForDb = globalThis as unknown as { __schulosDb?: Promise<DbHandle> };

export function getDbHandle(): Promise<DbHandle> {
  globalForDb.__schulosDb ??= (async () => {
    const handle = openDb({
      url: process.env.DATABASE_URL,
      dataDir: process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite"),
    });
    await handle.migrate();
    return handle;
  })();
  return globalForDb.__schulosDb;
}

export async function getDb(): Promise<Db> {
  return (await getDbHandle()).db;
}
