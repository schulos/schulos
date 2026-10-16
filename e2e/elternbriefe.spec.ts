import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Lehrkraft verschickt Elternbrief, Mutter bestätigt mit Ja, Lehrkraft sieht den Fortschritt", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/elternbriefe");
  await expect(page.getByRole("link", { name: /Elternabend der 7b.*18 von 25 bestätigt/ })).toBeVisible();
  await page.getByRole("link", { name: "Neuer Elternbrief" }).click();
  await page.getByLabel("Betreff").fill("Ausflug ins Museum");
  await page.getByLabel("Text", { exact: true }).fill("Liebe Eltern,\n\nam Freitag besuchen wir das **Naturkundemuseum**.");
  await page.getByLabel("Klasse 7b").check();
  await page.getByLabel("Rückmeldung", { exact: true }).selectOption("yesno");
  await page.getByLabel("Frage").fill("Darf Ihr Kind mitfahren?");
  await page.getByRole("button", { name: "Elternbrief verschicken" }).click();
  await expect(page.getByRole("heading", { name: "Ausflug ins Museum" })).toBeVisible();
  await expect(page.getByText("0 von 25 bestätigt")).toBeVisible();
  const letterUrl = page.url();

  const ctx = await browser.newContext();
  const mutter = await ctx.newPage();
  await login(mutter, "daniela.schaefer");
  await mutter.goto("/elternbriefe");
  await expect(mutter.getByRole("link", { name: /Ausflug ins Museum.*Rückmeldung offen/ })).toBeVisible();
  await mutter.getByRole("link", { name: /Ausflug ins Museum/ }).click();
  const form = mutter.getByRole("form", { name: "Rückmeldung für Lea Schäfer" });
  await form.getByLabel("Ja", { exact: true }).check();
  await form.getByRole("button", { name: "Für Lea Schäfer absenden" }).click();
  await expect(mutter.getByText(/Bestätigt am .* von Daniela Schäfer · Antwort: Ja/)).toBeVisible();
  await mutter.screenshot({ path: ".data/shots/e2e/elternbrief-eltern.png", fullPage: true });
  await ctx.close();

  await page.goto(letterUrl);
  await expect(page.getByText("1 von 25 bestätigt")).toBeVisible();
  await expect(page.getByRole("row", { name: /Lea Schäfer.*bestätigt.*Ja/ })).toBeVisible();
  await page.getByRole("button", { name: "24 Familien erinnern" }).click();
  await expect(page.getByText(/Zuletzt erinnert/)).toBeVisible();
  await expect(page.getByRole("button", { name: "24 Familien erinnern" })).toBeDisabled();
  await page.screenshot({ path: ".data/shots/e2e/elternbrief-lehrkraft.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("Schüler:innen sehen keine Elternbriefe", async ({ page }) => {
  await login(page, "lea.schaefer");
  const res = await page.goto("/elternbriefe");
  expect(res?.status()).toBe(404);
});
