import AxeBuilder from "./axe";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// GT-09/GT-10: Leas Mutter setzt den Heimweg für die Schülerzeitung (nur die Art) und ändert ihn für einen Termin morgen; die Leitung
// sieht Regel und Tagesänderung in der Liste und vermerkt an einem Termin heute „gegangen“ (Uhrzeit). Lea sieht ihren Heimweg nur
// (minderjährig) – 360 px dunkel, axe ohne Befund. Uhrzeiten ohne Demo- oder andere E2E-Termine; räumt alles wieder ab.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const TODAY_AT = "18:30";
const TOMORROW_AT = "18:40";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const berlinDate = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};

async function createSession(page: Page, date: string, start: string, end: string) {
  const single = page.getByRole("form", { name: "Einzeltermin anlegen" });
  await single.getByLabel("Datum").fill(date);
  await single.getByLabel("Beginn").fill(start);
  await single.getByLabel("Ende").fill(end);
  await single.getByRole("button", { name: "Termin anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Termin angelegt." })).toBeVisible();
}

test("GT-09/10: Heimweg der Familie, Tagesänderung, „gegangen“ in der Liste; 360 px dunkel", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const tomorrow = berlinDate(1);

  // Leitung: ein Termin heute und einer morgen
  await login(page, "jana.brandt");
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  await createSession(page, berlinDate(0), TODAY_AT, "18:35");
  await createSession(page, tomorrow, TOMORROW_AT, "18:45");
  await expect(page.getByRole("list", { name: "Heimweg der Teilnehmenden" })).toContainText("Lea Schäfer");
  expect(errors).toEqual([]);

  // Mutter: Regel „wird abgeholt“, für morgen „fährt mit dem Bus“
  const ctx = await browser.newContext();
  const mum = await ctx.newPage();
  const mumErrors = collectErrors(mum);
  await login(mum, "daniela.schaefer");
  await mum.goto("/ganztag");
  const rule = mum.getByRole("combobox", { name: "Heimweg nach AG Schülerzeitung" });
  await rule.selectOption({ label: "wird abgeholt" });
  await expect(mum.getByRole("status").filter({ hasText: "Heimweg gespeichert." })).toBeVisible();
  const days = mum.getByRole("list", { name: "Heimweg an den nächsten Terminen: AG Schülerzeitung" });
  const tomorrowSelect = days.getByRole("listitem").filter({ hasText: TOMORROW_AT }).getByRole("combobox");
  await expect(tomorrowSelect.locator("option").first()).toHaveText("wie immer (wird abgeholt)");
  await tomorrowSelect.selectOption({ label: "fährt mit dem Bus" });
  await expect(mum.getByRole("status").filter({ hasText: "Heimweg für den Tag gespeichert." })).toBeVisible();
  await expect(mum.getByText(/Wer abholt, wird nicht in SchulOS eingetragen/).first()).toBeVisible();
  await axeClean(mum);
  expect(mumErrors).toEqual([]);

  // Leitung: Gong und Liste morgen (nur lesen) mit Tagesänderung
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  await page.getByRole("link", { name: new RegExp(`${TOMORROW_AT}$`) }).first().click();
  const leaWay = page.getByLabel("Heimweg: Lea Schäfer");
  await expect(leaWay).toContainText("fährt mit dem Bus");
  await expect(leaWay).toContainText("für diesen Tag geändert");

  // heute: anwesend, dann „gegangen“ mit Uhrzeit
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  await page.getByRole("link", { name: new RegExp(`${TODAY_AT}$`) }).first().click();
  await expect(page.getByLabel("Heimweg: Lea Schäfer")).toContainText("wird abgeholt");
  const lea = page.getByRole("group", { name: "Lea Schäfer" });
  const present = lea.getByRole("button", { name: "anwesend" });
  if ((await present.getAttribute("aria-pressed")) !== "true") {
    const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/ganztag/termin/"));
    await present.click();
    await saved;
  }
  const left = page.getByRole("button", { name: "gegangen: Lea Schäfer" });
  await left.click();
  await expect(page.getByRole("button", { name: /^gegangen \d\d:\d\d: Lea Schäfer/ })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: /^gegangen \d\d:\d\d: Lea Schäfer/ })).toBeVisible();
  await axeClean(page);
  const todayUrl = page.url();
  expect(errors).toEqual([]);

  // Lea (minderjährig): Heimweg nur lesen, schmal und dunkel
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  await login(p, "lea.schaefer");
  await p.goto("/ganztag");
  await expect(p.getByRole("list", { name: "Meine Angebote" })).toContainText("wird abgeholt");
  await expect(p.getByRole("combobox", { name: "Heimweg nach AG Schülerzeitung" })).toHaveCount(0);
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await p.screenshot({ path: ".data/shots/e2e/ganztag-heimweg-360-dunkel.png", fullPage: true });
  expect(narrowErrors).toEqual([]);
  await narrow.close();

  // aufräumen: Regel der Mutter zurück, Termine löschen (Liste heute vorher leeren)
  await mum.goto("/ganztag");
  await mum.getByRole("combobox", { name: "Heimweg nach AG Schülerzeitung" }).selectOption({ label: "keine Angabe" });
  await expect(mum.getByRole("status").filter({ hasText: "Heimweg gespeichert." })).toBeVisible();
  await ctx.close();
  await page.goto(todayUrl);
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/ganztag/termin/"));
  await present.click();
  await saved;
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  for (const at of [TODAY_AT, TOMORROW_AT]) {
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: new RegExp(`${at} löschen$`) }).first().click();
    await expect(page.getByRole("link", { name: new RegExp(`${at}$`) })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await logoutForSwitch(page);
});
