// Setzt die lokale PGlite-Datenbank zurück und spielt die Demo-Schule ein.
// Der Dev-Server darf dabei nicht laufen (PGlite öffnet den Ordner exklusiv).
import { rmSync } from "node:fs";
import path from "node:path";
import { openDb } from "../src/core/db/client";
import { localStorage } from "../src/core/files/storage";
import { seedDemoSchool } from "../src/core/seed/seed";
import { DEMO_PASSWORD } from "../src/core/seed/data";

const dataDir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
if (process.env.DATABASE_URL) {
  console.error("DATABASE_URL ist gesetzt – db:reset ist nur für die lokale PGlite-DB gedacht.");
  process.exit(1);
}

const t0 = Date.now();
rmSync(dataDir, { recursive: true, force: true });
const handle = openDb({ dataDir });
await handle.migrate();
// SEED_CLOSURES=0: ohne Demo-Ferien (E2E) · SEED_ANMELDUNG=0: ohne Demo-Anmeldeverfahren (E2E, bis P4-43)
// Dateispeicher wie der Server (FILES_DIR, sonst .data/files) – dort landet das Demo-Logo
const storage = localStorage(process.env.FILES_DIR ?? path.join(process.cwd(), ".data", "files"));
const s = await seedDemoSchool(handle.db, { closures: process.env.SEED_CLOSURES !== "0", admissions: process.env.SEED_ANMELDUNG !== "0", storage });
await handle.close();

console.log(`Demo-Schule angelegt in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`  ${s.users} Konten:`, s.byRole);
console.log(`  ${s.groups} Gruppen, ${s.memberships} Mitgliedschaften`);
console.log(`  Login z. B. admin / jana.brandt / lea.schaefer / sabine.kowalski – Passwort "${DEMO_PASSWORD}"`);
