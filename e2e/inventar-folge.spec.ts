import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { collectErrors, login } from "./helpers";

// INV-08…INV-12: Wartungs-/Servicevertrag am Gerät (Formular, Geräteseite, Filter, CSV-Spalten), Frist-Hinweis „Wartungsvertrag“ in
// „Offen für dich“, Nutzungsdauer je Kategorie und Auswertung Ersatzbedarf mit CSV/Druck – am Handy (360 px, dunkel, axe inkl.
// Zielgröße). Rechte: Werte nur Verwaltung (configure/view_all), Hausmeisterei nur Stückzahlen, Lehrkraft/Schülerin 404.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const MOBILE = { viewport: { width: 360, height: 800 }, colorScheme: "dark" as const };

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Kein waagerechtes Scrollen bei 360 px (außerhalb von Scrollbereichen). */
async function noOverflow(page: Page) {
  const r = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    wide: [...document.querySelectorAll("main *")]
      .filter((e) => e.getBoundingClientRect().right > 361 && !e.closest(".overflow-x-auto, .overflow-auto, nav"))
      .slice(-5)
      .map((e) => `${e.tagName}.${String(e.className).slice(0, 60)} → ${Math.round(e.getBoundingClientRect().right)}: ${(e.textContent ?? "").slice(0, 50)}`),
  }));
  expect(r.width, r.wide.join(" | ")).toBeLessThanOrEqual(360);
}

/** JJJJ-MM-TT: heute + `months` Monate + `days` Tage (Berliner Datum, Monatsende begrenzt). */
function ymd(months: number, days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d!, last));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

async function mobilePage(browser: Browser, user: string) {
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { ctx, page, errors };
}

test("INV-08/09: Wartungsvertrag am Gerät, Filter, CSV-Spalten und Frist in „Offen für dich“", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, errors } = await mobilePage(browser, "sabine.kowalski");
  await page.goto("/gebaeude/inventar");
  const neu = page.getByRole("form", { name: "Inventar anlegen" });
  await neu.getByLabel("Bezeichnung").fill("E2E Kopierer Lehrerzimmer");
  await neu.getByLabel("Kategorie").selectOption({ label: "IT (Laptops, Tablets, PCs, Drucker, Server, Netzwerk, USV)" });
  await neu.getByLabel("Wartungspartner (Firma)").fill("E2E Bürotechnik GmbH");
  // Kündigungstag (Ende minus 3 Monate) in etwa 20 Tagen → im Vorlauf von 60 Tagen
  await neu.getByLabel("Vertragsende").fill(ymd(3, 20));
  await neu.getByLabel("Kündigungsfrist (Monate)").fill("3");
  await neu.getByLabel("Vertragsnotiz").fill("Wartung inkl. Toner, Vertrag 2026-17");
  await neu.getByRole("button", { name: "Anlegen" }).click();
  await expect(page).toHaveURL(/\/gebaeude\/inventar\/[^/?]+\?angelegt=1$/);
  const stamm = page.getByRole("article", { name: "Stammdaten" });
  await expect(stamm).toContainText("E2E Bürotechnik GmbH");
  await expect(stamm).toContainText("Kündigungsfrist 3 Monate");
  await expect(stamm).toContainText("Wartung inkl. Toner");
  await expect(stamm).toContainText("Nutzungsdauer (Richtwert)");
  await noOverflow(page);
  await axeClean(page);

  // Filter „mit Wartungsvertrag“: Kopierer und die Lüftung der Demo, kein Tablet-Koffer
  await page.goto("/gebaeude/inventar?vertrag=1");
  const list = page.getByRole("table", { name: "Inventar" });
  await expect(list).toContainText("E2E Kopierer Lehrerzimmer");
  await expect(list).toContainText("LU-001");
  await expect(list).not.toContainText("IT-0001");
  await noOverflow(page);

  // CSV: neue Spalten, ohne Vertragsnotiz
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Als CSV exportieren" }).click()]);
  const csv = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
  expect(csv.split("\r\n")[0]).toContain(";Garantie bis;Wartungspartner;Vertragsende;Kündigungsfrist (Monate);Letzte Prüfung;");
  expect(csv).toContain(";E2E Bürotechnik GmbH;");
  expect(csv).not.toContain("Toner");

  // „Offen für dich“ → Liste mit Frist „Wartungsvertrag“
  await page.goto("/");
  const due = page.locator('[data-widget="heute.offen"] [data-open-item="gebaeude:vertrag"]');
  await expect(due).toContainText("Wartungsvertrag: Frist");
  await expect(due).toContainText("E2E Kopierer Lehrerzimmer");
  await due.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/gebaeude\/inventar\?frist=vertrag$/);
  await expect(page.getByRole("table", { name: "Inventar" })).toContainText("E2E Kopierer Lehrerzimmer");
  await expect(page.getByRole("table", { name: "Inventar" })).not.toContainText("LU-001");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("INV-10/11: Nutzungsdauer je Kategorie und Ersatzbedarf mit CSV/Druck; Werte nur für die Verwaltung", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, errors } = await mobilePage(browser, "sabine.kowalski");
  // Kategorien: Richtwert aus der Vorlage
  await page.goto("/gebaeude/inventar/kategorien");
  const moebel = page.getByRole("list", { name: "Kategorien" }).getByRole("listitem").filter({ hasText: "Möbel (Tafeln" });
  await expect(moebel.locator("summary")).toContainText("15 Jahre");
  await moebel.locator("summary").click();
  await expect(moebel.getByLabel("Nutzungsdauer (Jahre)")).toHaveValue("15");
  await axeClean(page);

  // Ersatzbedarf: Schülertische der Demo über der Nutzungsdauer, Werte sichtbar
  await page.goto("/gebaeude/inventar");
  await page.getByRole("link", { name: "Ersatzbedarf" }).click();
  await expect(page).toHaveURL(/\/gebaeude\/inventar\/ersatzbedarf$/);
  await expect(page.getByRole("heading", { level: 1, name: "Ersatzbedarf" })).toBeVisible();
  const items = page.getByRole("table", { name: "Einträge mit Ersatzbedarf" });
  await expect(items.getByRole("row").filter({ hasText: "MO-0001" })).toContainText("Ersatz fällig");
  await expect(items).toContainText("IT-0001");
  await expect(page.getByRole("table", { name: "Ersatzbedarf je Kategorie" })).toContainText("Möbel");
  await expect(page.getByText(/Anschaffungswert/).first()).toBeVisible();
  await noOverflow(page);
  await axeClean(page);
  // Vorausschau 3 Jahre: Ergebnis bleibt lesbar, Raumfilter über die Tabelle je Raum
  await page.getByLabel("Vorausschau", { exact: true }).selectOption("3");
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await expect(page).toHaveURL(/jahre=3/);
  await page.getByRole("table", { name: "Ersatzbedarf je Raum" }).getByRole("link", { name: "Raum 205" }).click();
  await expect(page).toHaveURL(/raum=205/);
  await expect(page.getByRole("table", { name: "Einträge mit Ersatzbedarf" })).toContainText("MO-0001");
  await expect(page.getByRole("table", { name: "Einträge mit Ersatzbedarf" })).not.toContainText("IT-0001");

  // CSV mit Preisen, Druckansicht
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Als CSV exportieren" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^gebaeude-ersatzbedarf-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
  expect(csv.split("\r\n")[0]).toBe("Ersatz im Jahr;Stand;Inventarnummer;Bezeichnung;Kategorie;Standort;Menge;Anschaffungsdatum;Alter (Jahre);Nutzungsdauer (Jahre);Preis (EUR)");
  expect(csv).toContain(";MO-0001;Schülertische 7b;");
  await page.getByRole("link", { name: "Drucken" }).click();
  await expect(page).toHaveURL(/\/druck\/ersatzbedarf\?/);
  await expect(page.getByRole("navigation", { name: "Druckoptionen" })).toBeVisible();
  await expect(page.getByText("Erstellt mit SchulOS.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Schülertische 7b" })).toBeVisible();
  await axeClean(page);
  expect(errors).toEqual([]);
  await ctx.close();

  // Hausmeisterei: Stückzahlen ohne Werte (Seite und CSV)
  const k = await mobilePage(browser, "klaus.berger");
  await k.page.goto("/gebaeude/inventar/ersatzbedarf");
  await expect(k.page.getByRole("table", { name: "Einträge mit Ersatzbedarf" })).toContainText("MO-0001");
  await expect(k.page.getByText(/Anschaffungswert/)).toHaveCount(0);
  await expect(k.page.getByRole("columnheader", { name: "Preis" })).toHaveCount(0);
  const kcsv = await (await k.page.request.get("/api/gebaeude/export/ersatzbedarf")).text();
  expect(kcsv.split("\r\n")[0]).not.toContain("Preis");
  expect((await k.page.request.get("/gebaeude/inventar/kategorien")).status()).toBe(404);
  await noOverflow(k.page);
  await axeClean(k.page);
  expect(k.errors).toEqual([]);
  await k.ctx.close();

  // Lehrkraft ohne Verantwortung und Schülerin: Seite, Druck und CSV 404
  for (const user of ["jana.brandt", "lea.schaefer"]) {
    const u = await mobilePage(browser, user);
    for (const path of ["/gebaeude/inventar/ersatzbedarf", "/druck/ersatzbedarf", "/api/gebaeude/export/ersatzbedarf"]) expect((await u.page.request.get(path)).status(), `${user} ${path}`).toBe(404);
    await u.ctx.close();
  }
  // abgemeldet: CSV nicht lesbar
  const anon = await browser.newContext();
  const a = await anon.newPage();
  expect([401, 403, 404]).toContain((await a.request.get("/api/gebaeude/export/ersatzbedarf", { maxRedirects: 0 })).status());
  await anon.close();
});
