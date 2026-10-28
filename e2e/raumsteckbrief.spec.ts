import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// RS-02/RS-03: Raumsteckbrief je Rolle. Feste Schulwoche im Demo-Schuljahr (nicht vom heutigen Wochentag abhängig).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const WEEK = "2027-03-01";
const NW2 = `/raeume/NW2?woche=${WEEK}`;

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("RS-02: Steckbrief als Lehrkraft – Belegung mit Klasse und Lehrkraft, Personal-Infofelder, Mängel, Links", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  // Verlinkung aus der Raumbelegung
  await page.goto(`/stundenplan/raeume?ansicht=belegung&datum=${WEEK}`);
  await page.getByRole("table", { name: /Belegung aller Räume/ }).getByRole("link", { name: "NW2", exact: true }).click();
  await expect(page).toHaveURL(/\/raeume\/NW2/);
  await expect(page.getByRole("heading", { level: 1, name: "NW2 – Chemie-Raum" })).toBeVisible();

  await page.goto(NW2);
  await expect(page.getByText("Naturwissenschaften", { exact: true }).first()).toBeVisible();
  const grid = page.getByRole("region", { name: /^Belegung Raum NW2/ });
  await expect(grid.getByRole("columnheader")).toHaveCount(6);
  // Personal sieht Fach · Klasse (und Kürzel der Lehrkraft)
  await expect(grid.getByText(" · ", { exact: false }).first()).toBeVisible();
  const info = page.getByRole("article", { name: "Infofelder" });
  await expect(info.getByText("Technik/Netz")).toBeVisible();
  await expect(info.getByText(/Not-Aus/)).toBeVisible();
  await expect(info.getByText("nur Personal").first()).toBeVisible();
  await expect(page.getByRole("article", { name: "Offene Mängel" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mangel melden" })).toHaveAttribute("href", "/gebaeude/melden?raum=NW2");
  // Lehrkräfte pflegen keine Infofelder und bearbeiten keine Stammdaten (bis RS-06)
  await expect(page.getByRole("link", { name: "Infofelder bearbeiten" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Raum NW2 bearbeiten" })).toHaveCount(0);
  await axeClean(page);
  await page.screenshot({ path: ".data/shots/e2e/raumsteckbrief-lehrkraft.png", fullPage: true });

  // Druckansicht A4
  await page.getByRole("link", { name: "Drucken" }).click();
  await expect(page).toHaveURL(/\/druck\/raum\/NW2/);
  await expect(page.getByRole("heading", { name: "NW2 – Chemie-Raum" })).toBeVisible();
  await expect(page.getByText("Offene Mängel")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("RS-02: Steckbrief als Schülerin – nur frei/belegt, keine Lehrkraft, keine Mängel, keine Personal-Infofelder; 360 px dunkel", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  // Raumliste für alle
  await page.goto("/raeume");
  await page.getByRole("link", { name: /^NW2/ }).click();
  await expect(page).toHaveURL(/\/raeume\/NW2$/);

  await page.goto(NW2);
  await expect(page.getByRole("heading", { level: 1, name: "NW2 – Chemie-Raum" })).toBeVisible();
  await expect(page.getByText("Die Belegung zeigt nur, ob der Raum frei oder belegt ist.")).toBeVisible();
  const grid = page.getByRole("region", { name: /^Belegung Raum NW2/ });
  await expect(grid.getByText("belegt", { exact: true }).first()).toBeVisible();
  await expect(grid.getByText(" · ", { exact: false })).toHaveCount(0);
  const info = page.getByRole("article", { name: "Infofelder" });
  await expect(info.getByText("Fenster/Lüftung")).toBeVisible();
  await expect(info.getByText("Technik/Netz")).toHaveCount(0);
  await expect(page.getByText(/Not-Aus|HDMI/)).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Offene Mängel" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Mangel melden" })).toHaveCount(0);
  await axeClean(page);

  // schmal und dunkel: kein seitliches Scrollen, axe ohne Befund
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  await p.goto(NW2);
  await expect(p.getByRole("heading", { level: 1, name: "NW2 – Chemie-Raum" })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await p.screenshot({ path: ".data/shots/e2e/raumsteckbrief-schuelerin-360-dunkel.png", fullPage: true });
  await narrow.close();
  expect([...errors, ...narrowErrors]).toEqual([]);
});

test("RS-03: Sekretariat pflegt Infofelder (Hinweis „keine Personendaten“) und räumt wieder auf", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/stammdaten?bereich=raeume");
  await page.getByRole("link", { name: "Steckbrief Raum 015" }).click();
  await expect(page).toHaveURL(/\/raeume\/015$/);
  await page.getByRole("link", { name: "Infofelder bearbeiten" }).click();
  const form = page.getByRole("form", { name: "Infofelder" });
  await expect(form.getByRole("note")).toContainText("keine Namen");
  await form.getByLabel("Fläche").fill("58 m²");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Infofelder gespeichert." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Infofelder" }).getByText("58 m²")).toBeVisible();
  await axeClean(page);

  // zurücksetzen – kein Zustand für andere Tests
  await page.getByRole("link", { name: "Infofelder bearbeiten" }).click();
  await page.getByRole("form", { name: "Infofelder" }).getByLabel("Fläche").fill("");
  await page.getByRole("form", { name: "Infofelder" }).getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Infofelder gespeichert." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Infofelder" }).getByText("Keine Angaben.")).toBeVisible();

  // Infofelder schulweit verwalten
  await page.goto("/verwaltung/stammdaten/raeume/infofelder");
  await expect(page.getByRole("form", { name: "Infofeld Technik/Netz" }).getByLabel("Sichtbar für")).toHaveValue("personal");
  await expect(page.getByRole("form", { name: "Infofeld Fläche" }).getByLabel("Sichtbar für")).toHaveValue("alle");
  await axeClean(page);
  expect(errors).toEqual([]);
});
