import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Lehrkraft bucht den Laptopwagen, andere sehen die Buchung, Stornieren", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.getByRole("link", { name: "Buchungen", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Ressourcen" }).getByRole("link", { name: "Laptopwagen 1" }).click();
  await expect(page.getByRole("heading", { name: /^Laptopwagen 1/ })).toBeVisible();
  const before = page.url();
  await page.getByRole("link", { name: "Nächste Woche" }).click();
  await expect(page).not.toHaveURL(before);
  await page.getByLabel("Für Klasse/Kurs (optional)").selectOption({ label: "Klasse 7b" });
  await page.getByLabel("Notiz").fill("Recherche Mittelalter");
  const slot = page.getByRole("button", { name: /^Buchen: Mo\., .*, 3\. Stunde$/ });
  await slot.click();
  await expect(page.getByRole("status")).toHaveText("Gebucht.");
  const mine = page.locator("[data-booked]").filter({ hasText: "Meine Buchung" });
  await expect(mine).toContainText("Klasse 7b · Recherche Mittelalter");
  await page.screenshot({ path: ".data/shots/e2e/buchungen.png", fullPage: true });
  const url = page.url();

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await login(other, "daniel.okafor");
  await other.goto(url);
  await expect(other.locator("[data-booked]").filter({ hasText: "Jana Brandt" })).toBeVisible();
  await expect(other.getByRole("button", { name: /^Stornieren/ })).toHaveCount(0);
  await ctx.close();

  await mine.getByRole("button", { name: /^Stornieren/ }).click();
  await expect(page.locator("[data-booked]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Raum mit Unterricht ist nicht buchbar", async ({ page }) => {
  await login(page, "jana.brandt");
  await page.goto("/buchungen");
  await page.getByRole("navigation", { name: "Ressourcen" }).getByRole("link", { name: "Informatik-Raum (IF1)" }).click();
  await expect(page.getByRole("heading", { name: /^Informatik-Raum \(IF1\)/ })).toBeVisible();
  const before = page.url();
  await page.getByRole("link", { name: "Nächste Woche" }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByText(/^Unterricht · /).first()).toBeVisible();
});
