import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

// Der Backupserver hält nur Konten, Protokoll und Einstellungen – dafür reicht PGlite (eine Datei, kein eigener
// Datenbank-Container). Die Sicherungen selbst liegen im restic-Repository, nicht hier.
export type Db = PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/** Öffnet und migriert die Datenbank. Ohne `dataDir` In-Memory (Tests). */
export async function openDb(opts: { dataDir?: string; migrationsDir?: string } = {}): Promise<DbHandle> {
  if (opts.dataDir) mkdirSync(path.dirname(opts.dataDir), { recursive: true });
  const client = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: opts.migrationsDir ?? path.join(process.cwd(), "drizzle") });
  return { db, close: () => client.close() };
}

// Singleton über globalThis, damit Hot-Reload keine zweite PGlite-Instanz auf denselben Ordner öffnet.
const globalForDb = globalThis as unknown as { __backupDb?: Promise<DbHandle> };

export function getDbHandle(): Promise<DbHandle> {
  globalForDb.__backupDb ??= openDb({ dataDir: process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite") });
  return globalForDb.__backupDb;
}

export async function getDb(): Promise<Db> {
  return (await getDbHandle()).db;
}
