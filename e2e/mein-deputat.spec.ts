import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// Q5-09: Mein Deputat (nur eigene Zahlen) und eigene Pausenaufsichten im Stundenplan-Druck.
// Gong bei Aufsichtsvertretung und die Chips der Tagesleiste hängen vom Tag ab – das prüfen die Service-Tests
// (stundenplan/aufsichten.test.ts, mein-deputat.test.ts).
test("Mein Deputat: Lehrkraft sieht eigene Zahlen, Schülerin bekommt 404", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.getByRole("link", { name: "Mein Deputat" }).first().click();
  await expect(page.getByRole("heading", { name: "Mein Deputat", level: 1 })).toBeVisible();
  await expect(page.getByRole("article", { name: "Deputat" })).toContainText("Soll");
  await expect(page.getByRole("article", { name: /^Vertretungen im Schuljahr/ })).toContainText("vertreten (Mehrarbeit)");
  expect(errors).toEqual([]);

  const ctx = await browser.newContext();
  const lea = await ctx.newPage();
  await login(lea, "lea.schaefer");
  expect((await lea.goto("/stundenplan/deputat"))?.status()).toBe(404);
  await ctx.close();
});

test("Stundenplan-Druck der Lehrkraft listet ihre Pausenaufsichten", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/aufsichten");
  const plan = page.getByRole("form", { name: "Aufsicht einteilen" });
  await plan.getByLabel("Bereich").selectOption({ label: "Mensa" });
  await plan.getByLabel("Tag").selectOption({ label: "Fr" });
  await plan.getByLabel("Pause").selectOption({ index: 1 });
  await plan.getByLabel("Lehrkraft").selectOption({ label: "BRA – Jana Brandt" });
  await plan.getByRole("button", { name: "Einteilen" }).click();
  const remove = page.getByRole("button", { name: /^BRA aus Mensa Fr .* entfernen$/ });
  await expect(remove).toBeVisible();

  const ctx = await browser.newContext();
  const jana = await ctx.newPage();
  await login(jana, "jana.brandt");
  await jana.goto("/druck/stundenplan");
  await expect(jana.getByRole("region", { name: "Aufsichten" })).toContainText(/Fr nach der \d+\. \(\d\d:\d\d\) · Mensa/);
  await ctx.close();

  await remove.click();
  await expect(remove).toHaveCount(0);
  expect(errors).toEqual([]);
});
