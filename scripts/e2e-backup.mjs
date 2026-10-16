// E2E des Backupservers (+ leeres Produktiv-Hauptsystem für die Kopplung): frische Daten, dann Playwright.
// Aufruf: npm run e2e:backup [-- <playwright-Argumente>]   (vorher `npm run build`)
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const d of ["e2e-backup-pglite", "e2e-backup-rest", "e2e-pair-main-pglite", "e2e-pair-main-config"]) rmSync(`.data/${d}`, { recursive: true, force: true });
const args = ["npx playwright test -c apps/backup/playwright.config.ts", ...process.argv.slice(2).map((a) => JSON.stringify(a))];
const r = spawnSync(args.join(" "), { shell: true, stdio: "inherit" });
process.exit(r.status ?? 1);
