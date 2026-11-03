import { expect, test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { collectErrors, login } from "./helpers";

// GS-01…GS-03 (Runde 13): Fachraum-Prüfungen. Die Verwaltung gibt „Gefahrstoffverzeichnis“ der Fachschaft Chemie, die Fachschaft
// (Lehrkraft ohne Hausmeisterei-Rechte) findet ihre Prüfungen, plant eine, erfasst sie mit PDF und lädt das Protokoll – am Handy
// (360 px, dunkel, axe inkl. Zielgröße). Eine Lehrkraft ohne Gruppe bekommt 404. Termine liegen weit in der Zukunft, damit die
// Fristen anderer Tests (Gate 4b) unberührt bleiben; am Ende werden Gruppe und Schalter zurückgesetzt.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const MOBILE = { viewport: { width: 360, height: 800 }, colorScheme: "dark" as const };
const PDF = { name: "verzeichnis.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n") };
const TYPE = "Gefahrstoffverzeichnis aktualisieren und Bestand aussondern";
const GROUP = "Fachschaft Chemie";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Kein waagerechtes Scrollen bei 360 px; bei einem Fund die überstehenden Elemente (außerhalb von Scrollbereichen) nennen. */
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

/** JJJJ-MM-TT in `days` Tagen (Berliner Datum). */
function isoInDays(days: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date(Date.now() + days * 86_400_000));
}

async function mobilePage(browser: Browser, user: string) {
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { ctx, page, errors };
}

/** Prüfart „Gefahrstoffverzeichnis“ als Verwaltung einstellen: Gruppe (Label) und Schalter. */
async function configureType(page: Page, group: string, active: boolean) {
  await page.goto("/gebaeude/pruefarten");
  const item = page.getByRole("list", { name: "Fachraum-Prüfungen" }).getByRole("listitem").filter({ hasText: TYPE });
  await item.locator("summary").click();
  const form = item.getByRole("form", { name: `Prüfart ${TYPE}` });
  await form.getByLabel("zuständige Gruppe").selectOption({ label: group });
  if (active) await form.getByLabel("eingeschaltet").check();
  else await form.getByLabel("eingeschaltet").uncheck();
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert.");
}

test("GS-01…03: Fachschaft Chemie plant und erfasst „Gefahrstoffverzeichnis“ am Handy, andere Lehrkraft 404", async ({ browser }) => {
  test.setTimeout(180_000);
  const building = `Fachtrakt E2E ${Date.now() % 100_000}`;

  // Verwaltung: sieben Fachraum-Prüfarten in eigener Liste mit „zu prüfen“-Hinweis, Gruppe zuweisen und einschalten
  const admin = await mobilePage(browser, "sabine.kowalski");
  await admin.page.goto("/gebaeude/pruefarten");
  await expect(admin.page.getByRole("list", { name: "Fachraum-Prüfungen" }).getByRole("listitem")).toHaveCount(7);
  await expect(admin.page.getByText("keine Rechtsberatung")).toBeVisible();
  await noOverflow(admin.page);
  await configureType(admin.page, GROUP, true);
  await expect(admin.page.getByRole("list", { name: "Fachraum-Prüfungen" }).getByRole("listitem").filter({ hasText: TYPE })).toContainText(GROUP);

  // Fachschaft: Einstieg über „Gebäude & Technik“, nur die eigene Prüfart, keine Nachweise für den Schulträger
  const chem = await mobilePage(browser, "henrik.albers");
  await chem.page.goto("/gebaeude");
  await chem.page.getByRole("link", { name: "Prüfungen meiner Zuständigkeit" }).click();
  await expect(chem.page).toHaveURL(/\/gebaeude\/pruefungen$/);
  await expect(chem.page.getByText(`für die ${GROUP} zuständig ist`)).toBeVisible();
  await expect(chem.page.getByRole("link", { name: "CSV" })).toHaveCount(0);
  await expect(chem.page.getByRole("navigation", { name: "Gebäude & Technik" })).toHaveCount(0);
  const filterTypes = chem.page.getByRole("form", { name: "Filter" }).getByLabel("Prüfart").locator("option");
  await expect(filterTypes).toHaveText(["alle", TYPE]);
  await noOverflow(chem.page);
  await axeClean(chem.page);

  // planen (Gebäude), dann mit Verzeichnis als PDF erfassen
  const plan = chem.page.getByRole("form", { name: "Prüfung planen" });
  await expect(plan.getByLabel("Prüfart").locator("option")).toHaveCount(1);
  await plan.getByLabel("fällig am").fill(isoInDays(200));
  await plan.getByLabel("Gebäude").fill(building);
  await plan.getByRole("button", { name: "Planen" }).click();
  await expect(plan.getByRole("status")).toContainText("Geplant.");
  await chem.page.goto("/gebaeude/pruefungen");
  const item = chem.page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: building });
  await expect(item).toContainText(GROUP);
  await item.getByText("Ergebnis erfassen").click();
  await noOverflow(chem.page);
  await axeClean(chem.page);
  const rec = item.getByRole("form", { name: /^Prüfung erfassen/ });
  await rec.getByLabel("Firma bzw. Stelle").fill("Fachschaft Chemie");
  await rec.getByLabel("Protokoll (PDF)").setInputFiles(PDF);
  const saved = chem.page.waitForResponse((r) => r.request().method() === "POST");
  await rec.getByRole("button", { name: "Prüfung erfassen" }).click();
  await saved;
  await chem.page.goto("/gebaeude/pruefungen?stand=erledigt");
  const done = chem.page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: building });
  await expect(done).toContainText("ohne Mangel");
  const href = (await done.getByRole("link", { name: "Protokoll (PDF)" }).getAttribute("href"))!;
  const res = await chem.page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  await noOverflow(chem.page);
  await axeClean(chem.page);

  // Lehrkraft ohne Gruppe: kein Einstieg, Seite und Protokoll 404
  const other = await mobilePage(browser, "jana.brandt");
  await other.page.goto("/gebaeude");
  await expect(other.page.getByRole("link", { name: "Prüfungen meiner Zuständigkeit" })).toHaveCount(0);
  expect((await other.page.goto("/gebaeude/pruefungen"))?.status()).toBe(404);
  expect((await other.page.request.get(href)).status()).toBe(404);

  // Verwaltung sieht alles und kann auf „meine Zuständigkeit“ nicht filtern (in keiner zuständigen Gruppe); zurücksetzen
  await admin.page.goto("/gebaeude/pruefungen?stand=erledigt");
  await expect(admin.page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: building })).toHaveCount(1);
  await expect(admin.page.getByRole("form", { name: "Filter" }).getByLabel("Zuständigkeit")).toHaveCount(0);
  await configureType(admin.page, "keine (Hausmeisterei)", false);

  // die gewollten 404 der Lehrkraft ohne Gruppe meldet der Browser als Konsolenfehler
  expect([...admin.errors, ...chem.errors, ...other.errors.filter((e) => !e.includes("status of 404"))]).toEqual([]);
  await Promise.all([admin.ctx.close(), chem.ctx.close(), other.ctx.close()]);
});
