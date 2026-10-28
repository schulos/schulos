import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Lehrkraft trägt eine Stunde ins Klassenbuch ein, inkl. Fehlzeit und Verspätung", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.getByRole("link", { name: "Klassenbuch", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Meine Stunden" })).toBeVisible();
  const start = page.url();
  await page.getByRole("link", { name: "Vorheriger Schultag" }).click();
  await expect(page).not.toHaveURL(start);
  const open = page.getByRole("link", { name: /Offen$/ }).first();
  await expect(open).toBeVisible();
  // TD-16: genau diese Stunde später wieder öffnen – andere Specs tragen am selben Schultag ebenfalls Stunden ein
  const entryHref = (await open.getAttribute("href"))!;
  await open.click();

  await page.getByLabel("Thema der Stunde").fill("Erörterung: Pro und Contra");
  await page.getByLabel("Hausaufgabe").fill("Einleitung schreiben");
  const rows = page.getByRole("radiogroup");
  await rows.nth(1).getByText("Fehlt").click();
  await rows.nth(2).getByText("Verspätet").click();
  await page.getByRole("spinbutton").first().fill("10");
  await page.screenshot({ path: ".data/shots/e2e/klassenbuch-eintrag.png", fullPage: true });
  await page.getByRole("button", { name: "Eintrag speichern" }).click();

  await expect(page.getByRole("heading", { name: "Meine Stunden" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Eingetragen$/ }).first()).toBeVisible();
  await page.locator(`a[href="${entryHref}"]`).click();
  await expect(page.getByLabel("Thema der Stunde")).toHaveValue("Erörterung: Pro und Contra");
  await expect(rows.nth(1).getByRole("radio", { name: "Fehlt" })).toBeChecked();
  await expect(page.getByRole("spinbutton").first()).toHaveValue("10");
  await expect(page.getByLabel("Fällig am")).toHaveValue("");

  // Q5-27: „fällig am“ setzen – nur Schultage; ab einer Woche voraus den ersten Tag nehmen, den der Server annimmt
  const due = page.getByLabel("Fällig am");
  let chosen = "";
  for (let i = 7; i < 30 && !chosen; i++) {
    // Datum in Berlin (wie der Server), nicht in UTC – rund um Mitternacht liegen beide einen Tag auseinander
    const d = new Date(Date.now() + i * 86_400_000);
    const ymd = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const wd = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    await due.fill(ymd);
    await page.getByRole("button", { name: "Eintrag speichern" }).click();
    const saved = page.getByRole("heading", { name: "Meine Stunden" });
    const rejected = page.getByRole("alert").filter({ hasText: "Schultag" });
    await expect(saved.or(rejected)).toBeVisible();
    if (await saved.isVisible()) chosen = ymd;
  }
  expect(chosen).not.toBe("");
  await page.locator(`a[href="${entryHref}"]`).click();
  await expect(page.getByLabel("Fällig am")).toHaveValue(chosen);
  expect(errors).toEqual([]);
});

test("Schüler:innen haben kein Klassenbuch", async ({ page }) => {
  await login(page, "lea.schaefer");
  const res = await page.goto("/klassenbuch");
  expect(res?.status()).toBe(404);
});

test("Klassenleitung sieht Wochenraster mit fehlenden Einträgen und Fehlzeiten-Summen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/klassenbuch");
  await page.getByRole("link", { name: "Klassenbuch Klasse 7b" }).click();
  await expect(page.getByRole("heading", { name: "Klasse 7b", level: 1 })).toBeVisible();
  const before = page.url();
  await page.getByRole("link", { name: "Vorige Woche" }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page.locator('[data-status="done"]').first()).toBeVisible();
  await expect(page.locator('[data-status="missing"]').first()).toContainText("Eintrag fehlt");
  await page.getByRole("link", { name: "Schuljahr" }).click();
  const table = page.getByRole("table").last();
  await expect(table.getByRole("row")).toHaveCount(26);
  await expect(table.getByRole("row").nth(1).getByRole("cell").nth(1)).not.toHaveText("0");
  await page.screenshot({ path: ".data/shots/e2e/klassenbuch-klasse.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("Schulleitung wählt eine beliebige Klasse; fremde Lehrkraft kommt nicht in die 7b", async ({ page, browser }) => {
  await login(page, "petra.lindner");
  await page.goto("/klassenbuch/klasse");
  await page.getByLabel("Klasse").selectOption({ label: "Klasse 9a" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await expect(page.getByRole("heading", { name: "Klasse 9a", level: 1 })).toBeVisible();

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await login(other, "jana.brandt");
  const res = await other.goto("/klassenbuch/klasse?gruppe=g-9a");
  expect(res?.status()).toBe(404);
  await ctx.close();
});

test("Q5-06: eigene Stunden ohne Eintrag (nur Lehrkraft selbst), Tagesleisten-Karte führt weiter", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  // Demo-Klassenbuch gibt es nur für die 7b – in Janas anderen Gruppen fehlen Einträge
  const widget = page.getByRole("article", { name: "Klassenbuch ohne Eintrag" });
  await expect(widget).toContainText(/Stunden? ohne Eintrag/);
  await expect(widget).toContainText("nur für dich sichtbar");
  await widget.getByRole("link", { name: /Std/ }).first().click();
  await expect(page.getByLabel("Thema der Stunde")).toBeVisible();
  await page.goto("/klassenbuch");
  await expect(page.getByRole("region", { name: "Ohne Eintrag" })).toBeVisible();
  expect(errors).toEqual([]);

  // Schülerin: kein Lücken-Widget, Karte der Tagesleiste öffnet den Kursraum
  const ctx = await browser.newContext();
  const lea = await ctx.newPage();
  await login(lea, "lea.schaefer");
  await expect(lea.getByRole("region", { name: "Tagesleiste" })).toBeVisible();
  await expect(lea.getByRole("article", { name: "Klassenbuch ohne Eintrag" })).toHaveCount(0);
  await lea.getByRole("region", { name: "Tagesleiste" }).getByRole("link", { name: /Kursraum$/ }).first().click();
  await expect(lea).toHaveURL(/\/kurse\//);
  await ctx.close();
});
