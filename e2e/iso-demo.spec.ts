import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

/**
 * Demo-Schule, nur lesend (@iso): läuft in der normalen Suite und im QEMU-Test gegen ein aus der ISO installiertes
 * Demo-Hauptsystem (INSTALLATION.md §7 Schritt 4, `SCHULOS_E2E_URL=https://… npx playwright test --grep @iso`).
 * Verändert nichts – dieselbe Instanz kann danach weiter genutzt werden.
 */
test.describe("Demo-Schule @iso", () => {
  test("Demo-Band auf der Anmeldeseite", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("note").filter({ hasText: "DEMO – keine echten Daten eingeben" })).toBeVisible();
  });

  for (const [username, name] of [
    ["lea.schaefer", "Lea"],
    ["jana.brandt", "Jana Brandt"],
    ["petra.lindner", "Petra Lindner"],
    ["sabine.kowalski", "Sabine"],
  ] as const) {
    test(`${username}: Anmeldung und Startseite ohne Browser-Fehler`, async ({ page }) => {
      const errors = collectErrors(page);
      await login(page, username);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
      await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("Schülerin sieht ihre Tagesleiste, Lehrkraft das Klassenbuch der 7b", async ({ page }) => {
    await login(page, "lea.schaefer");
    await expect(page.getByRole("region", { name: "Tagesleiste" })).toHaveAttribute("data-day", /^\d{4}-\d{2}-\d{2}$/);
    await page.goto("about:blank");
    await page.context().clearCookies();
    await login(page, "jana.brandt");
    await page.goto("/klassenbuch");
    await expect(page.locator('a[href^="/klassenbuch/eintrag"]').first()).toBeVisible();
  });

  test("Verwaltung zeigt die Demo-Schule", async ({ page }) => {
    await login(page, "sabine.kowalski");
    await page.getByRole("link", { name: "Verwaltung" }).click();
    await expect(page.getByRole("heading", { name: "Gesamtschule am Lindenhof" })).toBeVisible();
  });

  for (const path of ["/monitor/demo-foyer-lindenhof-2026", "/monitor/demo-lehrerzimmer-lindenhof-2026"]) {
    test(`Statusmonitor ohne Anmeldung: ${path}`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Vertretungsplan" })).toBeVisible();
      await expect(page.getByLabel("Uhrzeit")).toHaveText(/\d{2}:\d{2}/);
      expect(errors).toEqual([]);
    });
  }
});
