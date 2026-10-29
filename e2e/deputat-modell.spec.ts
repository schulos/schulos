import AxeBuilder from "./axe";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP3-DEP: Deputatsmodell – Teilzeit-Anteil als Rechenhilfe, Pflicht 2. Halbjahr, Anrechnung mit Gültigkeit, Rechnung am Stichtag.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const TEACHER = "u-aylin.demir";
const card = `/planung/unterricht?ansicht=lehrkraefte&lehrkraft=${TEACHER}`;

test("SP3-DEP: Teilzeit-Anteil, Pflicht 2. Halbjahr, Anrechnung ab/bis – Karte, Stichtag, „Mein Deputat“, mobil + dunkel", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/unterricht?ansicht=lehrkraefte");
  await page.getByRole("link", { name: "DEM", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Deputat", exact: true })).toBeVisible();
  // Bestand: Vorgabe, keine Halbjahrs-Tabelle
  await expect(page.getByRole("table", { name: "Deputat je Halbjahr" })).toHaveCount(0);

  // Rechenhilfe: 25,5 × 50 % = 12,75 → 13
  await page.getByLabel("Teilzeit-Anteil in %").fill("50");
  await expect(page.getByText("Rechenhilfe: 25,5 × 50 % =")).toContainText("13 Std.");
  await page.getByRole("button", { name: "In Pflichtstunden übernehmen" }).click();
  await expect(page.getByLabel("Pflichtstunden")).toHaveValue("13");
  await page.getByLabel("Pflicht ab 2. Halbjahr").fill("15");
  await page.getByRole("button", { name: "Pflichtstunden speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
  await expect(page.getByText("Soll 13", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Teilzeit 50 %", { exact: false })).toBeVisible();
  const terms = page.getByRole("table", { name: "Deputat je Halbjahr" });
  await expect(terms.getByRole("row")).toHaveCount(3);
  await expect(terms.getByRole("row").nth(2)).toContainText("15");

  // Anrechnung erst am letzten Schultag: gilt am Stichtag (heute) nicht
  const yearEnd = (await page.getByLabel("gültig bis").getAttribute("max"))!;
  await page.getByLabel("Grund").selectOption({ label: "Fachbereichs- / Fachleitung (Anrechnung)" });
  await page.getByLabel("Stunden", { exact: true }).fill("1");
  await page.getByLabel("gültig ab").fill(yearEnd);
  await page.getByRole("button", { name: "Hinzufügen" }).click();
  const row = page.getByRole("table", { name: "Ermäßigungen und Anrechnungen" }).getByRole("row").filter({ hasText: "Fachbereichs- / Fachleitung" });
  await expect(row.getByText("gilt am Stichtag nicht")).toBeVisible();
  await expect(page.getByText("Soll 13", { exact: true }).first()).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.screenshot({ path: ".data/shots/e2e/deputat-modell.png", fullPage: true });

  // Stichtag am Schuljahresende: 2. Halbjahr, Pflicht 15 − 1 Anrechnung = Soll 14
  await page.goto(`${card}&stichtag=${yearEnd}`);
  await expect(page.getByText("(2. Halbjahr)", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Soll 14", { exact: true }).first()).toBeVisible();
  await expect(row.getByText("gilt am Stichtag nicht")).toHaveCount(0);

  // schmal und dunkel: Karte ohne axe-Befund, ohne seitliches Scrollen
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  await p.goto(card);
  const dep = p.locator("[aria-labelledby=dep]");
  await expect(dep).toBeVisible();
  const res = await new AxeBuilder({ page: p }).withTags(TAGS).include("[aria-labelledby=dep]").analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  const form = await p.getByRole("button", { name: "Pflichtstunden speichern" }).boundingBox();
  expect(form!.x + form!.width).toBeLessThanOrEqual(360);
  await narrow.close();

  // die Lehrkraft sieht ihre eigene Rechnung
  const own = await browser.newPage();
  await login(own, "aylin.demir");
  await own.goto("/stundenplan/deputat");
  const mine = own.getByRole("article", { name: "Deputat" });
  await expect(mine.getByText("Teilzeit-Anteil")).toBeVisible();
  await expect(mine.getByText("50 %")).toBeVisible();
  await expect(mine.getByText(/^2\. Halbjahr \(ab .*\): Pflicht 15$/)).toBeVisible();
  await expect(mine.getByText(/^gilt heute nicht – Anrechnung: Fachbereichs- \/ Fachleitung, ab /)).toBeVisible();
  await own.close();

  // aufräumen: Anrechnung entfernen, eigene Angaben leeren → wieder Vorgabe
  await page.goto(card);
  await page.getByRole("button", { name: "Fachbereichs- / Fachleitung entfernen" }).click();
  await expect(page.getByRole("button", { name: "Fachbereichs- / Fachleitung entfernen" })).toHaveCount(0);
  await page.getByLabel("Pflichtstunden").fill("");
  await page.getByLabel("Teilzeit-Anteil in %").fill("");
  await page.getByLabel("Pflicht ab 2. Halbjahr").fill("");
  await page.getByRole("button", { name: "Pflichtstunden speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
  await expect(page.getByRole("table", { name: "Deputat je Halbjahr" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
