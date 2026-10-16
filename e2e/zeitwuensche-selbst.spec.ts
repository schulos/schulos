import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

function ymd(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Q5-10 (I-47): Planung öffnet das Eingabefenster → Lehrkraft bekommt einen Gong und trägt ihre eigenen Zeitwünsche ein →
// Planung sieht „selbst abgegeben“. Die Erinnerung vor der Frist prüft der Service-Test (zeitwunsch-fenster.test.ts).
test("Zeitwünsche selbst: Fenster öffnen, Lehrkraft trägt ein, Planung sieht den Stand; Schülerin 404", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/unterricht/zeitwuensche");
  const card = page.getByRole("article", { name: "Eingabefenster für Lehrkräfte" });
  const form = card.getByRole("form", { name: "Eingabefenster" });
  await form.getByLabel("Erster Tag").fill(ymd(0));
  await form.getByLabel("Letzter Tag").fill(ymd(14));
  await form.getByRole("button", { name: "Fenster speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await page.reload();
  await expect(card).toContainText("Offen");

  const ctx = await browser.newContext();
  const jana = await ctx.newPage();
  const janaErrors = collectErrors(jana);
  await login(jana, "jana.brandt");
  await jana.getByRole("button", { name: /Gong/ }).click();
  await expect(jana.getByText(/^Zeitwünsche bis .* abgeben$/).first()).toBeVisible();
  await jana.goto("/stundenplan/zeitwuensche");
  await expect(jana.getByRole("heading", { name: "Meine Zeitwünsche", level: 1 })).toBeVisible();
  await expect(jana.getByText("Eingabe offen")).toBeVisible();
  const grid = jana.getByRole("form", { name: "Zeitwünsche Jana Brandt" });
  await grid.getByLabel("Fr 6. Stunde").selectOption("x");
  await grid.getByRole("button", { name: "Zeitwünsche speichern" }).click();
  await expect(grid.getByRole("status")).toContainText("Gespeichert");
  await jana.reload();
  await expect(jana.getByLabel("Fr 6. Stunde")).toHaveValue("x");
  await expect(jana.getByText("abgegeben", { exact: true })).toBeVisible();
  await jana.screenshot({ path: ".data/shots/e2e/zeitwuensche-selbst.png", fullPage: true });
  expect(janaErrors).toEqual([]);
  await ctx.close();

  await page.reload();
  await expect(card).toContainText(/[1-9]\d* von \d+ Lehrkräften haben abgegeben/);
  await expect(page.getByRole("link", { name: /BRA – Jana Brandt/ })).toContainText("selbst abgegeben");
  // Fenster wieder schließen (andere Specs erwarten keinen offenen Zeitraum)
  await card.getByRole("button", { name: "Fenster schließen" }).click();
  await expect(card).toContainText("Kein Eingabefenster");
  expect(errors).toEqual([]);

  const lctx = await browser.newContext();
  const lea = await lctx.newPage();
  await login(lea, "lea.schaefer");
  expect((await lea.goto("/stundenplan/zeitwuensche"))?.status()).toBe(404);
  await lctx.close();
});
