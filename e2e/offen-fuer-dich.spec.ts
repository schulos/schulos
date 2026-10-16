import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// Q5-07 (I-10, I-27): Widget „Offen für dich“ auf Heute. Mutter meldet krank → Mutter sieht „noch nicht entschieden“,
// Klassenleitung „entscheiden“ (Link zur Abwesenheitsseite), Schülerin nichts davon. Lieferanten je Rolle (Elternbrief-
// Rücklauf mit „Erinnern“, Umfragen, Vertretungsbedarf, Entwürfe, Zeitwünsche, Backup) prüft open-items.test.ts.
test("Offen für dich: Krankmeldung erscheint bei Mutter und Klassenleitung, nicht bei der Schülerin", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "daniela.schaefer");
  const mine = page.locator('[data-widget="heute.offen"]');
  await expect(mine.getByRole("heading", { name: "Offen für dich" })).toBeVisible();
  await page.goto("/abwesenheiten");
  await page.getByLabel("Schüler:in").selectOption({ label: "Lea Schäfer" });
  await page.getByLabel("krank").check();
  await page.getByRole("button", { name: "Abwesenheit melden" }).click();
  await expect(page.getByRole("status")).toContainText("Klassenleitung ist benachrichtigt");
  await page.goto("/");
  await expect(mine.locator('[data-open-item="abwesenheiten:gemeldet"]')).toContainText("noch nicht entschieden");
  await page.screenshot({ path: ".data/shots/e2e/offen-fuer-dich-eltern.png", fullPage: true });

  const ctx = await browser.newContext();
  const jana = await ctx.newPage();
  const janaErrors = collectErrors(jana);
  await login(jana, "jana.brandt");
  const decide = jana.locator('[data-widget="heute.offen"] [data-open-item="abwesenheiten:entscheiden"]');
  await expect(decide).toContainText("entscheiden");
  await jana.screenshot({ path: ".data/shots/e2e/offen-fuer-dich-lehrkraft.png", fullPage: true });
  await decide.getByRole("link").click();
  await expect(jana).toHaveURL(/\/abwesenheiten$/);
  await jana.getByRole("button", { name: "Entschuldigen: Lea Schäfer", exact: true }).first().click();
  await jana.goto("/");
  await expect(jana.locator('[data-widget="heute.offen"]')).toBeVisible();
  expect(janaErrors).toEqual([]);
  await ctx.close();

  const lctx = await browser.newContext();
  const lea = await lctx.newPage();
  await login(lea, "lea.schaefer");
  const leaBox = lea.locator('[data-widget="heute.offen"]');
  await expect(leaBox.getByRole("heading", { name: "Offen für dich" })).toBeVisible();
  await expect(leaBox.locator('[data-open-item^="abwesenheiten:"]')).toHaveCount(0);
  await lctx.close();
  expect(errors).toEqual([]);
});
