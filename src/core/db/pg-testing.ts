// Integrationstests gegen echtes PostgreSQL (B-14): aktiv, wenn TEST_DATABASE_URL gesetzt ist.
// globalSetup migriert einmal eine Vorlage-DB, jede createTestDb() kopiert sie (CREATE DATABASE … TEMPLATE)
// und löscht die Kopie beim Schließen wieder. Ohne TEST_DATABASE_URL laufen die Tests mit In-Memory-PGlite.
import { randomBytes } from "node:crypto";
import postgres from "postgres";

export const PG_TEMPLATE_DB = "schulos_test_template";

/** Admin-URL derselben Instanz mit anderer Datenbank. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function testDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  return url && /^postgres(ql)?:\/\//.test(url) ? url : undefined;
}

/** Legt eine frische Kopie der Vorlage an und gibt URL + Aufräumfunktion zurück. */
export async function createPgTestDatabase(adminUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `schulos_t_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name} template ${PG_TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  return {
    url: withDatabase(adminUrl, name),
    drop: async () => {
      const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await a.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
