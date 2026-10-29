import AxeBuilder from "./axe";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP3-LA: Matrix Klasse × Fach – Typeahead nur mit Lehrfach, live Deputatsbilanz, Speichern zellweise (Enter) und gesammelt, Esc,
// „Trotzdem zuweisen“, Übernahme-Knöpfe, mobil + dunkel ohne axe-Befund.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const MATRIX = "/planung/unterricht?ansicht=matrix&jahrgang=7";

test("SP3-LA: Matrix – Lehrkraft per Typeahead, Live-Bilanz, Enter/Esc, fachfremd mit Bestätigung, Übernahme, mobil + dunkel", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/unterricht");
  await page.getByRole("navigation", { name: "Ansicht" }).getByRole("link", { name: "Matrix" }).click();
  await expect(page.getByRole("heading", { name: /^Matrix Klasse × Fach · Jahrgang 5$/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Jahrgang" }).getByRole("link", { name: "7", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Matrix Klasse × Fach · Jahrgang 7" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Matrix Klasse × Fach (Tabelle)" })).toBeVisible();

  const teacher = page.getByLabel("Lehrkraft Klasse 7b, Deutsch", { exact: true });
  const hours = page.getByLabel("Wochenstunden Klasse 7b, Deutsch", { exact: true });
  await expect(teacher).toHaveValue("BRA");
  const before = await hours.inputValue();
  expect(Number(before)).toBeGreaterThan(0);
  // Vorschläge: nur Lehrkräfte mit dem Lehrfach Deutsch; mit „alle“ auch fachfremde
  await expect(page.locator("datalist#matrix-lk-D option[value=BEC]")).toHaveCount(1);
  await expect(page.locator("datalist#matrix-lk-D option[value=KLE]")).toHaveCount(0);
  await page.getByLabel("alle Lehrkräfte vorschlagen (auch fachfremd)").check();
  await expect(page.locator("datalist#matrix-lk-D option[value=KLE]")).toHaveCount(1);
  await page.getByLabel("alle Lehrkräfte vorschlagen (auch fachfremd)").uncheck();

  // live Bilanz: BRA gibt die Stunden ab, BEC bekommt sie
  await teacher.fill("bec");
  const bilanz = page.getByRole("table", { name: "Deputatsbilanz der betroffenen Lehrkräfte" });
  await expect(bilanz.getByRole("row")).toHaveCount(3);
  await expect(bilanz.getByRole("row").filter({ hasText: "BRA" })).toContainText(`−${before}`);
  await expect(bilanz.getByRole("row").filter({ hasText: "BEC" })).toContainText(`+${before}`);
  await expect(page.getByText("1 ungespeicherte Änderung.")).toBeVisible();
  // Esc setzt die Zelle zurück
  await teacher.press("Escape");
  await expect(teacher).toHaveValue("BRA");
  await expect(bilanz).toHaveCount(0);

  // Enter speichert die Zelle
  await teacher.fill("BEC");
  await teacher.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "1 Änderung gespeichert." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Lehrkraft Klasse 7b, Deutsch", { exact: true })).toHaveValue("BEC");

  // 0 Stunden = löschen (nur angezeigt, mit Esc verworfen); unbekanntes Kürzel → Hinweis, nicht speicherbar
  await hours.fill("0");
  await expect(page.getByText("wird gelöscht")).toBeVisible();
  await hours.press("Escape");
  await expect(hours).toHaveValue(before);
  const english = page.getByLabel("Lehrkraft Klasse 7b, Englisch", { exact: true });
  const englishBefore = await english.inputValue();
  await english.fill("XYZ");
  await expect(page.getByText("„XYZ“ ist keine Lehrkraft")).toBeVisible();
  await expect(page.getByRole("button", { name: "Änderungen speichern (0)" })).toBeDisabled();

  // fachfremd: KLE unterrichtet Englisch nicht – Häkchen „trotzdem“ nötig; gesammelt speichern (Deutsch zurück auf BRA)
  await english.fill("KLE");
  await page.getByLabel("Lehrkraft Klasse 7b, Deutsch", { exact: true }).fill("BRA");
  await page.getByLabel(/^Trotzdem zuweisen: KLE unterrichtet Englisch/).check();
  await page.getByRole("button", { name: "Änderungen speichern (2)" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 Änderungen gespeichert." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Lehrkraft Klasse 7b, Englisch", { exact: true })).toHaveValue("KLE");
  await expect(page.getByLabel("Lehrkraft Klasse 7b, Deutsch", { exact: true })).toHaveValue("BRA");
  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.screenshot({ path: ".data/shots/e2e/unterricht-matrix.png", fullPage: true });

  // Übernahme: Demo hat kein Vorjahr; im 2. Halbjahr gibt es den Knopf fürs 1. Halbjahr
  await page.getByRole("link", { name: "Aus dem Vorjahr übernehmen" }).click();
  await expect(page.getByRole("note").filter({ hasText: "Keine Übernahme möglich: Es gibt kein Vorjahr." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Aus dem 1. Halbjahr übernehmen" })).toHaveCount(0);
  const yearEnd = (await page.getByRole("textbox", { name: "Stichtag" }).getAttribute("max"))!;
  await page.goto(`${MATRIX}&stichtag=${yearEnd}`);
  await page.getByRole("link", { name: "Aus dem 1. Halbjahr übernehmen" }).click();
  await expect(page.getByRole("note").filter({ hasText: "Keine Vorschläge aus dem 1. Halbjahr" })).toBeVisible();

  // schmal und dunkel: ohne seitliches Scrollen der Seite (Matrix scrollt im beschrifteten Rahmen), ohne axe-Befund
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  await p.goto(MATRIX);
  await expect(p.getByRole("region", { name: "Matrix Klasse × Fach (Tabelle)" })).toBeVisible();
  await p.getByLabel("Lehrkraft Klasse 7a, Deutsch", { exact: true }).fill("BEC");
  await expect(p.getByRole("table", { name: "Deputatsbilanz der betroffenen Lehrkräfte" })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const res = await new AxeBuilder({ page: p }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await p.screenshot({ path: ".data/shots/e2e/unterricht-matrix-mobil.png", fullPage: true });
  await narrow.close();

  // aufräumen: Englisch zurück
  await page.goto(MATRIX);
  const en = page.getByLabel("Lehrkraft Klasse 7b, Englisch", { exact: true });
  await en.fill(englishBefore);
  await en.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "1 Änderung gespeichert." })).toBeVisible();
  expect(errors).toEqual([]);
});
