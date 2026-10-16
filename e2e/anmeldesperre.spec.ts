import { expect, test, type Page } from "@playwright/test";
import { collectErrors, DEMO_PASSWORD, login } from "./helpers";

async function attempt(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

test("Anmeldesperre: 5 Fehlversuche sperren, Verwaltung sieht die Sperre und hebt sie auf", async ({ page }) => {
  const errors = collectErrors(page);
  for (let i = 0; i < 5; i++) {
    await attempt(page, "markus.hoffmann", "falsch!!");
    await expect(page.getByRole("alert").filter({ hasText: "Benutzername oder Passwort ist falsch." })).toBeVisible();
  }
  // gesperrt – auch mit dem richtigen Passwort
  await attempt(page, "markus.hoffmann", DEMO_PASSWORD);
  await expect(page.getByRole("alert").filter({ hasText: /Zu viele Fehlversuche\. Die Anmeldung ist bis \d\d:\d\d Uhr gesperrt\./ })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await login(page, "admin");
  await page.goto("/verwaltung");
  const card = page.getByRole("article", { name: "Gesperrte Anmeldungen" });
  await expect(card).toContainText("Markus Hoffmann");
  await expect(card).toContainText("5 Fehlversuche");
  await page.screenshot({ path: ".data/shots/e2e/anmeldesperre.png", fullPage: true });
  await card.getByRole("button", { name: "Sperre Markus Hoffmann aufheben" }).click();
  await expect(card).toHaveCount(0);
  await page.goto("/verwaltung/protokoll");
  await expect(page.getByText("Anmeldung nach Fehlversuchen vorübergehend gesperrt").first()).toBeVisible();
  await expect(page.getByText("Anmeldesperre aufgehoben").first()).toBeVisible();
  expect(errors).toEqual([]);

  await page.context().clearCookies();
  await login(page, "markus.hoffmann");
});
