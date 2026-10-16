// E2E-Lauf: eigene DB frisch seeden, dann Playwright (der Server startet über webServer).
// Aufruf: npm run e2e [-- <playwright-Argumente>]   (vorher `npm run build`)
import { spawnSync } from "node:child_process";

// ohne Demo-Ferien: E2E-Läufe sollen nicht vom echten Datum abhängen (Ferien testet stammdaten.spec selbst); ohne
// Demo-Anmeldeverfahren (P4-41, bewusst auch nach P4-43): die Specs legen eigene Verfahren an, Schuljahreswechsel erwartet kein Schuljahr 2027/28
const env = { ...process.env, PGLITE_DIR: ".data/e2e-pglite", SEED_CLOSURES: "0", SEED_ANMELDUNG: "0" };
const run = (cmd) => {
  const r = spawnSync(cmd, { shell: true, stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("npx tsx scripts/db-reset.ts");
run(["npx playwright test", ...process.argv.slice(2).map((a) => JSON.stringify(a))].join(" "));
