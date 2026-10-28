import AxeBuilder from "./axe";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// GT-01…GT-03: Ganztag – Liste für eine AG einschalten, Serie mit Ferien, Einzeltermin erfassen (leer starten, „alle anwesend“),
// Ausfall, Leitung nur eigene Gruppen; Liste auf 360 px dunkel. Feste Serien-Daten (Oster- und Pfingstmontag; die E2E-DB hat keine
// Demo-Ferien), Einzeltermine
// am Tag des Laufs zu einer Uhrzeit ohne Demo-Termin – unabhängig von Wochentag und Uhrzeit. Räumt alles wieder ab.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const status = (page: Page) => page.getByRole("status", { name: "Stand der Liste" });

async function expectCounts(page: Page, counts: Partial<Record<"anwesend" | "fehlt" | "verspätet" | "offen", number>>) {
  for (const [label, n] of Object.entries(counts)) await expect(status(page).getByText(`${n} ${label}`, { exact: true })).toBeVisible();
}

test("GT-01…03: Verwaltung schaltet die Liste ein, legt Serie und Termin an, erfasst; Leitung sieht nur die eigene AG; 360 px dunkel", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");

  // Liste für die AG Schulchor einschalten
  await page.goto("/ganztag");
  await expect(page.getByRole("heading", { level: 1, name: "Ganztag" })).toBeVisible();
  await page.getByRole("link", { name: "Angebote mit Liste" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Angebote mit Liste" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Anwesenheitsliste für AG Schulchor" });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Anwesenheitsliste für AG Robotik" })).toBeChecked();
  await expect(page.getByText("7b", { exact: true })).toHaveCount(0); // Klassen gibt es hier nicht
  await toggle.check();
  await expect(toggle).toBeChecked();
  await axeClean(page);
  await page.getByRole("link", { name: "AG Schulchor" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "AG Schulchor" })).toBeVisible();

  // Serie montags 22.03.–24.05.2027: Ostermontag und Pfingstmontag übersprungen
  const series = page.getByRole("form", { name: "Serie anlegen" });
  await series.getByLabel("Wochentag").selectOption({ label: "Montag" });
  await series.getByLabel("Beginn").fill("14:00");
  await series.getByLabel("Ende").fill("15:30");
  await series.getByLabel("Gültig ab").fill("2027-03-22");
  await series.getByLabel("Gültig bis").fill("2027-05-24");
  await series.getByRole("button", { name: "Serie anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "8 Termine angelegt. 2 Tage übersprungen" })).toBeVisible();
  const seriesList = page.getByRole("list", { name: "Serien" });
  await expect(seriesList).toContainText("Montag 14:00–15:30");
  await expect(seriesList).toContainText("22.03.2027 bis 24.05.2027 · 8 Termine");

  // Ausfall eines Serientermins und zurück
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Mo, 22.03.2027 14:00 fällt aus" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ausfall vermerkt" })).toBeVisible();
  await page.getByRole("button", { name: "Mo, 22.03.2027 14:00 findet statt" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Termin findet wieder statt." })).toBeVisible();

  // Einzeltermin heute (Vorgabe im Formular) zu einer Zeit ohne Demo-Termin, Liste erfassen
  const single = page.getByRole("form", { name: "Einzeltermin anlegen" });
  await single.getByLabel("Beginn").fill("16:45");
  await single.getByLabel("Ende").fill("17:30");
  await single.getByRole("button", { name: "Termin anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Termin angelegt." })).toBeVisible();
  await page.getByRole("link", { name: /16:45$/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /16:45–17:30/ })).toBeVisible();
  const list = page.getByRole("region", { name: "Anwesenheitsliste" });
  const rows = list.getByRole("group");
  const n = await rows.count();
  expect(n).toBeGreaterThan(2);
  // leer gestartet
  await expectCounts(page, { anwesend: 0, fehlt: 0, verspätet: 0, offen: n });
  await expect(list.getByRole("button", { pressed: true })).toHaveCount(0);
  await axeClean(page);
  // „alle anwesend“, dann eine Zeile auf „fehlt“
  await list.getByRole("switch", { name: "Alle anwesend" }).check();
  await expectCounts(page, { anwesend: n, fehlt: 0, offen: 0 });
  await rows.first().getByRole("button", { name: "fehlt" }).click();
  await expect(rows.first().getByRole("button", { name: "fehlt" })).toHaveAttribute("aria-pressed", "true");
  await expectCounts(page, { anwesend: n - 1, fehlt: 1 });
  await page.reload();
  await expect(list.getByRole("switch", { name: "Alle anwesend" })).toBeChecked();
  await expect(rows.first().getByRole("button", { name: "fehlt" })).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);

  // Leitung der Schülerzeitung: sieht nur ihre AG, nicht den Schulchor
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto("/ganztag");
  const offers = page.getByRole("list", { name: "Angebote" });
  await expect(offers.getByRole("heading", { name: "AG Schülerzeitung" })).toBeVisible();
  await expect(offers.getByRole("heading", { name: "AG Schulchor" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Angebote mit Liste" })).toHaveCount(0);
  expect((await page.goto("/ganztag/gruppe/g-ag-schulchor"))?.status()).toBe(404);
  expect((await page.goto("/ganztag/angebote"))?.status()).toBe(404);
  errors.length = 0; // die beiden 404 sind gewollt
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  const own = page.getByRole("form", { name: "Einzeltermin anlegen" });
  await own.getByLabel("Beginn").fill("16:45");
  await own.getByLabel("Ende").fill("17:30");
  await own.getByRole("button", { name: "Termin anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Termin angelegt." })).toBeVisible();
  await page.getByRole("link", { name: /16:45$/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /16:45–17:30/ })).toBeVisible();
  const sessionUrl = page.url();

  // schmal und dunkel: Lea verspätet mit 10 Minuten, kein seitliches Scrollen, axe ohne Befund
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  await p.goto(sessionUrl);
  const lea = p.getByRole("group", { name: "Lea Schäfer" });
  await lea.getByRole("button", { name: "verspätet" }).click();
  await p.getByLabel("Minuten verspätet: Lea Schäfer").selectOption("10");
  await expectCounts(p, { verspätet: 1 });
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await p.screenshot({ path: ".data/shots/e2e/ganztag-liste-360-dunkel.png", fullPage: true });
  await p.goto("/ganztag");
  await expect(p.getByRole("heading", { level: 1, name: "Ganztag" })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await narrow.close();
  expect(narrowErrors).toEqual([]);

  // aufräumen (Leitung): Zeile leeren → Termin wieder ohne Erfassung → löschen
  await page.reload();
  const leaRow = page.getByRole("group", { name: "Lea Schäfer" });
  await expect(leaRow.getByRole("button", { name: "verspätet" })).toHaveAttribute("aria-pressed", "true");
  await leaRow.getByRole("button", { name: "verspätet" }).click();
  await expectCounts(page, { verspätet: 0 });
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: /16:45 löschen$/ }).first().click();
  await expect(page.getByRole("link", { name: /16:45$/ })).toHaveCount(0);
  expect(errors).toEqual([]);

  // aufräumen (Verwaltung): Serie, erfassten Einzeltermin, Merkmal
  await logoutForSwitch(page);
  await login(page, "sabine.kowalski");
  await page.goto("/ganztag/gruppe/g-ag-schulchor");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Serie Montag 14:00–15:30 löschen" }).click();
  await expect(page.getByRole("list", { name: "Serien" })).toHaveCount(0);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: /16:45 löschen$/ }).first().click();
  await expect(page.getByRole("link", { name: /16:45$/ })).toHaveCount(0);
  await page.goto("/ganztag/angebote");
  await page.getByRole("switch", { name: "Anwesenheitsliste für AG Schulchor" }).uncheck();
  await expect(page.getByRole("switch", { name: "Anwesenheitsliste für AG Schulchor" })).not.toBeChecked();
  expect(errors).toEqual([]);
});
