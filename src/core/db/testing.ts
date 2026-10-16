import { hashPassword } from "better-auth/crypto";
import { DEMO_PASSWORD } from "@/core/seed/data";
import { seedDemoSchool } from "@/core/seed/seed";
import { openDb, type DbHandle } from "./client";
import { createPgTestDatabase, testDatabaseUrl } from "./pg-testing";

/**
 * Frische, migrierte Datenbank für Integrationstests: In-Memory-PGlite oder – mit TEST_DATABASE_URL –
 * eine eigene Datenbank auf echtem PostgreSQL (Kopie der in pg-global-setup migrierten Vorlage).
 */
export async function createTestDb(): Promise<DbHandle> {
  const pgUrl = testDatabaseUrl();
  if (pgUrl) {
    const { url, drop } = await createPgTestDatabase(pgUrl);
    const handle = openDb({ url, max: 3 });
    return {
      ...handle,
      migrate: async () => {}, // Vorlage ist bereits migriert
      close: async () => {
        await handle.close();
        await drop();
      },
    };
  }
  const handle = openDb();
  await handle.migrate();
  return handle;
}

let demoHash: Promise<string> | undefined;

/** Frische In-Memory-DB mit der kompletten Demo-Schule (Passwort-Hash wird einmal pro Testlauf berechnet). */
export async function createSeededTestDb(): Promise<DbHandle> {
  demoHash ??= hashPassword(DEMO_PASSWORD);
  const handle = await createTestDb();
  // ohne Demo-Ferien: Tests wählen feste Daten, Ferien testen eigene Fälle; ohne Demo-Anmeldeverfahren (P4-41) – die
  // Anmelde-Tests legen Schuljahr 2027/28 und ihre Verfahren selbst an
  // Vertretungsplan auf der Vorgabe „sofort“ – die Freigabe (Q5-11) testet freigabe.test.ts gezielt
  await seedDemoSchool(handle.db, { passwordHash: await demoHash, closures: false, admissions: false, substitutionRelease: false });
  return handle;
}
