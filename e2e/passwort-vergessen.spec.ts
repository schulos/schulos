import { expect, test } from "@playwright/test";
import { collectErrors } from "./helpers";

// P4-70: „Passwort vergessen“ ohne Anmeldung erreichbar; die Antwort verrät nicht, ob es das Konto gibt bzw. ob es berechtigt ist
// (Link nur für Konten mit 2FA und bestätigter Adresse – die Regeln prüft passwort-reset.test.ts). Ungültige Links: Hinweis.
test("P4-70: Passwort vergessen – gleiche Antwort für jedes Konto, ungültiger Link", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/login");
  await page.getByRole("link", { name: "Passwort vergessen?" }).click();
  await expect(page).toHaveURL("/passwort-vergessen");
  for (const who of ["jana.brandt", "gibt.es.nicht"]) {
    await page.goto("/passwort-vergessen");
    const form = page.getByRole("form", { name: "Passwort vergessen" });
    await form.getByLabel("Benutzername oder E-Mail-Adresse").fill(who);
    await form.getByRole("button", { name: "Link anfordern" }).click();
    await expect(page.getByRole("status")).toContainText("Wenn es zu dieser Angabe ein Konto");
  }
  await page.goto("/passwort-vergessen/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
  await expect(page.getByRole("alert").filter({ hasText: "ungültig oder abgelaufen" })).toBeVisible();
  expect(errors).toEqual([]);
});
