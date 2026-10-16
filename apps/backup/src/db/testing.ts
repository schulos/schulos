import path from "node:path";
import { openDb, type DbHandle } from "./client";

/** Frische In-Memory-Datenbank je Aufruf (Tests laufen aus dem Repo-Root, daher der Migrationspfad). */
export function createTestDb(): Promise<DbHandle> {
  return openDb({ migrationsDir: path.join(import.meta.dirname, "..", "..", "drizzle") });
}
