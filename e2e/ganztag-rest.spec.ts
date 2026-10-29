import AxeBuilder from "./axe";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// GT-04…GT-08: Verwaltung macht die Schülerzeitung verpflichtend und sieht die Auswertung ohne Namen (auch CSV); die Leitung erfasst
// Lea als „fehlt“ an einem Einzeltermin heute (Uhrzeit ohne Demo- oder andere E2E-Termine); die Klassenleitung (dieselbe Lehrkraft,
// KL 7b) sieht die Zeile mit „Pflichtangebot“; Lea und ihre Mutter sehen nur Leas Zeile – 360 px dunkel, axe ohne Befund.
// Den abendlichen Hinweis an die Klassenleitung (Job) prüfen die DB-Tests. Ob Lea heute schon eine Meldung hat (andere Specs), ist
// egal: „entschuldigt?“ wird nicht geprüft. Räumt alles wieder ab.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const START = "18:10";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function setMandatory(page: Page, on: boolean) {
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  const form = page.getByRole("form", { name: "Einstellungen des Angebots" });
  const box = form.getByRole("checkbox", { name: /Verpflichtendes Angebot/ });
  await box.setChecked(on);
  await form.getByRole("button", { name: "Einstellungen speichern" }).click();
  await expect(form.getByRole("status")).toHaveText("Einstellungen gespeichert.");
}

test("GT-04…08: Pflichtangebot, Klassenleitung, Familie, Auswertung ohne Namen; 360 px dunkel", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);

  // Verwaltung: Schülerzeitung verpflichtend, Auswertung ohne Namen
  await login(page, "sabine.kowalski");
  await setMandatory(page, true);
  await page.reload();
  await expect(page.getByText(/verpflichtendes Angebot/).first()).toBeVisible();
  await page.goto("/ganztag");
  await page.getByRole("link", { name: "Auswertung" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Auswertung" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Offen heute" })).toBeVisible();
  const table = page.getByRole("region", { name: "Auswertung je Angebot und Monat" });
  await expect(table).toContainText("AG Robotik");
  await expect(page.getByText("Lea Schäfer")).toHaveCount(0);
  await axeClean(page);
  const csv = await page.request.get("/api/ganztag/auswertung");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const body = await csv.text();
  expect(body).toContain("Teilnehmertage");
  expect(body).toContain("AG Robotik");
  expect(body).not.toContain("Lea");
  expect(errors).toEqual([]);

  // Leitung der Schülerzeitung: Einzeltermin heute, Lea fehlt
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  await expect(page.getByRole("form", { name: "Einstellungen des Angebots" })).toHaveCount(0); // nur „Ganztag verwalten“
  const single = page.getByRole("form", { name: "Einzeltermin anlegen" });
  await single.getByLabel("Beginn").fill(START);
  await single.getByLabel("Ende").fill("18:50");
  await single.getByRole("button", { name: "Termin anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Termin angelegt." })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(`${START}$`) }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`${START}–18:50`) })).toBeVisible();
  await expect(page.getByText(/Verpflichtendes Angebot: unentschuldigtes Fehlen geht abends als Hinweis/)).toBeVisible();
  const lea = page.getByRole("group", { name: "Lea Schäfer" });
  const fehlt = lea.getByRole("button", { name: "fehlt" });
  // mit Krankmeldung von heute ist „fehlt“ schon vorbelegt – sonst setzen
  if ((await fehlt.getAttribute("aria-pressed")) !== "true") {
    const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/ganztag/termin/"));
    await fehlt.click();
    await saved;
  }
  await page.reload();
  await expect(fehlt).toHaveAttribute("aria-pressed", "true");
  const sessionUrl = page.url();

  // dieselbe Lehrkraft als Klassenleitung der 7b
  await page.goto("/ganztag");
  await page.getByRole("link", { name: "Meine Klasse" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /7b/ })).toBeVisible();
  const rows = page.getByRole("list", { name: "Gefehlt und verspätet" });
  const leaRow = rows.getByRole("listitem").filter({ hasText: "Lea Schäfer" }).filter({ hasText: "AG Schülerzeitung" }).first();
  await expect(leaRow).toContainText("Pflichtangebot");
  await expect(leaRow).toContainText("gefehlt");
  await expect(page.getByRole("list", { name: "Teilnahme an Angeboten" })).toContainText("Lea Schäfer");
  await axeClean(page);
  expect(errors).toEqual([]);

  // Lea selbst: nur die eigenen Zeilen, schmal und dunkel
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  await login(p, "lea.schaefer");
  await p.goto("/ganztag");
  await expect(p.getByRole("heading", { level: 1, name: "Ganztag" })).toBeVisible();
  await expect(p.getByRole("list", { name: "Meine Angebote" })).toContainText("AG Schülerzeitung");
  const mine = p.getByRole("list", { name: "Meine Anwesenheit" });
  await expect(mine.getByRole("listitem").filter({ hasText: "AG Schülerzeitung" }).filter({ hasText: START }).first()).toContainText("gefehlt");
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await p.screenshot({ path: ".data/shots/e2e/ganztag-familie-360-dunkel.png", fullPage: true });
  // Leitungs- und Auswertungsseiten gibt es für Schüler:innen nicht
  expect((await p.goto(sessionUrl))?.status()).toBe(404);
  expect((await p.goto("/ganztag/auswertung"))?.status()).toBe(404);
  expect((await p.goto("/ganztag/klasse"))?.status()).toBe(404);
  expect((await p.request.get("/api/ganztag/auswertung")).status()).toBe(404);
  narrowErrors.length = 0; // die 404 sind gewollt
  await narrow.close();

  // Mutter: Leas Zeile
  const ctx = await browser.newContext();
  const mum = await ctx.newPage();
  const mumErrors = collectErrors(mum);
  await login(mum, "daniela.schaefer");
  await mum.goto("/ganztag");
  await expect(mum.getByRole("heading", { level: 2, name: "Ganztag: Lea Schäfer" })).toBeVisible();
  await expect(
    mum
      .getByRole("list", { name: "Anwesenheit von Lea Schäfer" })
      .getByRole("listitem")
      .filter({ hasText: "AG Schülerzeitung" })
      .filter({ hasText: START })
      .first(),
  ).toContainText("gefehlt");
  await axeClean(mum);
  expect(mumErrors).toEqual([]);
  await ctx.close();

  // aufräumen (Leitung): Zeile leeren → Termin ohne Erfassung → löschen
  await page.goto(sessionUrl);
  await expect(fehlt).toHaveAttribute("aria-pressed", "true");
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/ganztag/termin/"));
  await fehlt.click();
  await saved;
  await page.goto("/ganztag/gruppe/g-ag-schuelerzeitung");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: new RegExp(`${START} löschen$`) }).first().click();
  await expect(page.getByRole("link", { name: new RegExp(`${START}$`) })).toHaveCount(0);
  expect(errors).toEqual([]);

  // aufräumen (Verwaltung): nicht mehr verpflichtend
  await logoutForSwitch(page);
  await login(page, "sabine.kowalski");
  await setMandatory(page, false);
  expect(errors).toEqual([]);
});
