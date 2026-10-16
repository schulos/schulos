import { defineConfig, devices } from "@playwright/test";

// E2E des Backupservers: gebaute Apps (`npm run build`), frische Datenbanken, Admins aus der Konfiguration wie nach dem Installer.
// Zusätzlich läuft ein leeres Produktiv-Hauptsystem (Port 3141) – für die Kopplung über beide Oberflächen (lokal per http).
// Aufruf aus dem Repo-Root: npm run e2e:backup
const PORT = 3140;
export const MAIN_PORT = 3141;
export const MAIN_ADMIN = { username: "m.mueller", password: "Tafel Kreide Pause" };
const SECRET = "e2e-backup-secret-nur-fuer-tests-0123456789";

export const E2E_ADMIN = { username: "it.admin", password: "Tafel Kreide Pause", name: "Ina Tech" };

export default defineConfig({
  testDir: "e2e",
  outputDir: "../../.data/e2e-backup-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: `npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PGLITE_DIR: "../../.data/e2e-backup-pglite",
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: `http://localhost:${PORT}`,
        SCHULOS_REST_DIR: "../../.data/e2e-backup-rest",
        SCHULOS_JOBS: "0",
        SCHULOS_ADMIN_USERNAME: E2E_ADMIN.username,
        SCHULOS_ADMIN_FIRST_NAME: "Ina",
        SCHULOS_ADMIN_LAST_NAME: "Tech",
        SCHULOS_ADMIN_PASSWORD: E2E_ADMIN.password,
      },
    },
    {
      // Hauptsystem aus dem Repo-Root, leere Produktivinstanz
      command: `npx next start -p ${MAIN_PORT}`,
      cwd: "../..",
      url: `http://localhost:${MAIN_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        PGLITE_DIR: ".data/e2e-pair-main-pglite",
        SCHULOS_CONFIG_DIR: ".data/e2e-pair-main-config",
        SCHULOS_INSTANCE: "production",
        SCHULOS_JOBS: "0",
        SCHULOS_SCHOOL_NAME: "Gesamtschule am Lindenhof",
        SCHULOS_SCHOOL_STATE: "NW",
        SCHULOS_ADMIN_USERNAME: MAIN_ADMIN.username,
        SCHULOS_ADMIN_FIRST_NAME: "Maria",
        SCHULOS_ADMIN_LAST_NAME: "Müller",
        SCHULOS_ADMIN_PASSWORD: MAIN_ADMIN.password,
        SCHULOS_BACKUP_ALLOW_HTTP: "1",
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: `http://localhost:${MAIN_PORT}`,
      },
    },
  ],
});
