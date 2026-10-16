// vitest globalSetup: bei TEST_DATABASE_URL die Vorlage-DB einmal frisch anlegen und migrieren.
import postgres from "postgres";
import { openDb } from "./client";
import { PG_TEMPLATE_DB, testDatabaseUrl, withDatabase } from "./pg-testing";

export default async function setup() {
  const adminUrl = testDatabaseUrl();
  if (!adminUrl) return;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // Reste abgebrochener Läufe wegräumen
    const stale = await admin<{ datname: string }[]>`select datname from pg_database where starts_with(datname, 'schulos_t_')`;
    for (const { datname } of stale) await admin.unsafe(`drop database if exists ${datname} with (force)`);
    await admin.unsafe(`drop database if exists ${PG_TEMPLATE_DB} with (force)`);
    await admin.unsafe(`create database ${PG_TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const handle = openDb({ url: withDatabase(adminUrl, PG_TEMPLATE_DB) });
  await handle.migrate();
  await handle.close();
  console.log(`[pg] Tests laufen gegen PostgreSQL (${new URL(adminUrl).host}), Vorlage migriert`);
}
