import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// P4-71: „Angemeldete Geräte“ – Übersicht, ein anderes Gerät abmelden, überall abmelden; Inaktivitätsablauf als Einstellung.
test("P4-71: Sitzungsübersicht, anderes Gerät abmelden, überall abmelden", async ({ page, browser }) => {
  const errors = collectErrors(page);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await login(otherPage, "markus.hoffmann");
  await login(page, "markus.hoffmann");

  await page.goto("/konto/sitzungen");
  const card = page.getByRole("article", { name: "Sitzungen" });
  await expect(card.getByText("dieses Gerät")).toHaveCount(1);
  const buttons = card.getByRole("button", { name: "Abmelden" });
  expect(await buttons.count()).toBeGreaterThanOrEqual(1);
  page.on("dialog", (d) => void d.accept());
  // alle anderen Geräte einzeln abmelden
  for (let n = await buttons.count(); n > 0; n--) {
    await buttons.first().click();
    await expect(buttons).toHaveCount(n - 1);
  }

  // das andere Gerät ist abgemeldet
  await otherPage.goto("/");
  await expect(otherPage).toHaveURL(/\/login/);

  // überall abmelden – Rückfrage (Dialog wird oben bestätigt), danach Anmeldung
  await page.getByRole("button", { name: "Überall abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/konto/sitzungen");
  await expect(page).toHaveURL(/\/login/);
  await other.close();
  expect(errors).toEqual([]);
});

test("P4-71: Inaktivitätsablauf als Einstellung unter Verwaltung → System → Anmeldung", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/verwaltung/system/anmeldung");
  const form = page.getByRole("form", { name: "Anmelde-Einstellungen" });
  await expect(form.getByLabel("Abmelden nach Inaktivität")).toHaveValue("0");
  await form.getByLabel("Abmelden nach Inaktivität").selectOption("480");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await page.reload();
  await expect(page.getByRole("form", { name: "Anmelde-Einstellungen" }).getByLabel("Abmelden nach Inaktivität")).toHaveValue("480");
  // zurück auf aus (andere Specs)
  await page.getByRole("form", { name: "Anmelde-Einstellungen" }).getByLabel("Abmelden nach Inaktivität").selectOption("0");
  await page.getByRole("form", { name: "Anmelde-Einstellungen" }).getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("form", { name: "Anmelde-Einstellungen" }).getByRole("status")).toContainText("Gespeichert");
});
