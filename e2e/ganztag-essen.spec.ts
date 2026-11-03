import AxeBuilder from "./axe";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// GT-11/GT-12: Verwaltung pflegt den Speiseplan des nächsten Montags, Leas Mutter meldet Lea an
// und wählt ein Menü (Hinweis zu Allergien sichtbar, kein Feld dafür); die Verwaltung sieht Zahl, Ausgabeliste und CSV ohne Namen;
// Lea sieht nur (minderjährig) – 360 px dunkel, axe ohne Befund. Räumt alles wieder ab.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** nächster Montag (Berliner Datum) – liegt in den zwei Wochen der Familienansicht; die Spec überschreibt die Demo-Menüs des Tages */
function targetDay(): string {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = new Date(`${fmt(new Date())}T12:00:00Z`);
  const wd = (today.getUTCDay() + 6) % 7;
  return fmt(new Date(today.getTime() + (7 - wd) * 86_400_000));
}

test("GT-11/12: Speiseplan, Anmeldung mit Menü, Küchenzahlen und Ausgabeliste; 360 px dunkel", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const day = targetDay();

  // Verwaltung: Menüs des Tages setzen
  await login(page, "sabine.kowalski");
  await page.goto(`/ganztag/essen?woche=${day}`);
  await expect(page.getByRole("heading", { level: 1, name: "Mittagessen" })).toBeVisible();
  const form = page.getByRole("form", { name: new RegExp(`^Speiseplan .*${day.split("-").reverse().join(".")}`) });
  await form.getByLabel("Menü 1").fill("E2E Kartoffelsuppe");
  await form.getByLabel("Menü 2").fill("E2E Gemüsepfanne");
  await form.getByLabel("Menü 3").fill("");
  await form.getByLabel("Menü 4").fill("");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toHaveText("Gespeichert: 2 Menüs.");
  await axeClean(page);
  expect(errors).toEqual([]);

  // Mutter: Lea anmelden, Menü 2
  const ctx = await browser.newContext();
  const mum = await ctx.newPage();
  const mumErrors = collectErrors(mum);
  await login(mum, "daniela.schaefer");
  await mum.goto("/ganztag");
  const meals = mum.getByRole("list", { name: "Mittagessen der nächsten Tage: Lea Schäfer" });
  const select = meals.getByRole("combobox", { name: new RegExp(`${day.split("-").reverse().join("\\.")}: Lea Schäfer$`) });
  await select.selectOption({ label: "Menü 2: E2E Gemüsepfanne" });
  await expect(mum.getByRole("status").filter({ hasText: "Angemeldet: Menü 2." })).toBeVisible();
  await expect(mum.getByText(/Allergien und Unverträglichkeiten bitte direkt mit der Küche/).first()).toBeVisible();
  await axeClean(mum);
  expect(mumErrors).toEqual([]);

  // Verwaltung: Zahl, Ausgabeliste, CSV ohne Namen
  await page.reload();
  await expect(form.getByText("1 Anmeldung")).toBeVisible();
  await page.goto(`/ganztag/essen/ausgabe?datum=${day}`);
  const table = page.getByRole("region", { name: "Ausgabeliste" });
  await expect(table.getByRole("row").filter({ hasText: "Lea Schäfer" })).toContainText("2");
  await expect(table).toContainText("7b");
  await axeClean(page);
  const csv = await page.request.get(`/api/ganztag/essen?von=${day}&bis=${day}`);
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body).toContain("E2E Gemüsepfanne");
  expect(body).not.toContain("Lea");
  expect(errors).toEqual([]);

  // Lea: sieht die Anmeldung, ändert nicht – 360 px dunkel
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  await login(p, "lea.schaefer");
  await p.goto("/ganztag");
  const mine = p.getByRole("list", { name: "Mittagessen der nächsten Tage" });
  await expect(mine).toContainText("Menü 2: E2E Gemüsepfanne");
  await expect(mine.getByRole("combobox")).toHaveCount(0);
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await p.screenshot({ path: ".data/shots/e2e/ganztag-essen-360-dunkel.png", fullPage: true });
  expect((await p.goto("/ganztag/essen"))?.status()).toBe(404);
  narrowErrors.length = 0; // die 404 ist gewollt
  await narrow.close();

  // aufräumen: abmelden, Menüs leeren
  await select.selectOption({ label: "nicht angemeldet" });
  await expect(mum.getByRole("status").filter({ hasText: "Abgemeldet." })).toBeVisible();
  await ctx.close();
  await page.goto(`/ganztag/essen?woche=${day}`);
  await form.getByLabel("Menü 1").fill("");
  await form.getByLabel("Menü 2").fill("");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toHaveText("Gespeichert: kein Essen an diesem Tag.");
  expect(errors).toEqual([]);
  await logoutForSwitch(page);
});
