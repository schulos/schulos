import { defineConfig, devices } from "@playwright/test";

const PORT = 3130;
// Eigene DB für E2E – die lokale Arbeits-DB (.data/pglite) bleibt unberührt.
const PGLITE_DIR = ".data/e2e-pglite";
// Gegen eine laufende Instanz statt eines eigenen Servers (QEMU-Test §7.4: Demo aus der ISO, selbst signiertes Zertifikat);
// SCHULOS_E2E_RESOLVE="name ip" leitet den Namen ohne DNS auf die VM.
const EXTERNAL = process.env.SCHULOS_E2E_URL;
const RESOLVE = process.env.SCHULOS_E2E_RESOLVE?.trim();

export default defineConfig({
  testDir: "e2e",
  outputDir: ".data/e2e-results",
  fullyParallel: false,
  workers: 1, // PGlite: ein Server-Prozess, eine DB
  retries: 0,
  forbidOnly: !!process.env.CI,
  // in der CI zusätzlich Fehler als Annotationen am Commit
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: EXTERNAL ?? `http://localhost:${PORT}`,
    ...(EXTERNAL ? { ignoreHTTPSErrors: true } : {}),
    ...(RESOLVE ? { launchOptions: { args: [`--host-resolver-rules=MAP ${RESOLVE.split(/\s+/).join(" ")}`] } } : {}),
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, grepInvert: /@mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: EXTERNAL
    ? undefined
    : {
        // Baut nicht selbst – vorher `npm run build` (macht `npm run e2e`).
        command: `npx next start -p ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { PGLITE_DIR, SCHULOS_DEMO_LOGIN: "1", SCHULOS_DEV_MAIL: "1" },
      },
});
