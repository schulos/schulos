import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// HB-01…HB-04: Handbuch – Bereich + Seite anlegen, Sichtbarkeit je Zielgruppe (Eltern), Suche, „?“ in der Kopfzeile.
// Unabhängig von Wochentag und Uhrzeit; legt eigene Daten an und räumt sie wieder ab.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("HB-02/03: Sekretariat legt Bereich und Seiten an – Eltern sehen nur ihre, Suche und „?“ führen hin; 360 px dunkel", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");

  // „?“ in der Kopfzeile öffnet das Handbuch
  await page.getByRole("banner").getByRole("link", { name: "Handbuch", exact: true }).click();
  await expect(page).toHaveURL(/\/hilfe$/);
  await expect(page.getByRole("heading", { level: 1, name: "Handbuch" })).toBeVisible();
  // Demo: Überprüfung der Kopierer-Seite ist fällig – Widget für Pflegende
  await page.goto("/");
  await expect(page.locator('[data-widget="hilfe.ueberpruefung"]')).toContainText("Kopierer im Lehrerzimmer");

  // Bereich anlegen
  await page.goto("/hilfe/bereiche");
  const create = page.getByRole("form", { name: "Bereich anlegen" });
  await create.getByLabel("Neuer Bereich").fill("E2E Elterninfos");
  await create.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("form", { name: "Bereich E2E Elterninfos" })).toBeVisible();
  await axeClean(page);

  // Seite für Eltern (Vorgabe beim Anlegen: nur Personal → umstellen)
  await page.goto("/hilfe/neu");
  const form = page.getByRole("form", { name: "Handbuchseite" });
  await form.getByLabel("Bereich").selectOption({ label: "E2E Elterninfos" });
  await form.getByLabel("Status").selectOption("veroeffentlicht");
  await form.getByLabel("Titel").fill("E2E Mittagessen bestellen");
  await expect(form.getByRole("note")).toContainText("keine Schülerdaten");
  await form.getByLabel("Text", { exact: true }).fill("Das **Mittagessen** wird bis Donnerstag für die Folgewoche bestellt.\n\nSiehe auch [Fundsachen](/hilfe/fundsachen).");
  await form.getByLabel("Ansprechperson").selectOption({ label: "Jana Brandt" });
  await expect(form.getByLabel("Lehrkräfte")).toBeChecked();
  await expect(form.getByLabel("Eltern")).not.toBeChecked();
  for (const r of ["Lehrkräfte", "Personal", "Beratung (Schulsozialarbeit)", "Verwaltung"]) await form.getByLabel(r, { exact: true }).uncheck();
  await form.getByLabel("Eltern", { exact: true }).check();
  await axeClean(page);
  await form.getByRole("button", { name: "Seite anlegen" }).click();
  await expect(page).toHaveURL(/\/hilfe\/e2e-mittagessen-bestellen$/);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Mittagessen bestellen" })).toBeVisible();
  await expect(page.getByText("Mittagessen", { exact: true })).toBeVisible();
  await expect(page.getByText("Jana Brandt")).toBeVisible();
  await expect(page.getByText(/fällig am/)).toBeVisible();
  await axeClean(page);
  // Druckansicht
  await page.getByRole("link", { name: "Drucken" }).click();
  await expect(page).toHaveURL(/\/druck\/hilfe\/e2e-mittagessen-bestellen$/);
  await expect(page.getByRole("heading", { name: "E2E Mittagessen bestellen" })).toBeVisible();
  expect(errors).toEqual([]);

  // Elternteil: sieht die Seite, nicht die Personal-Seite; Suche und globale Suche finden sie
  await logoutForSwitch(page);
  await login(page, "daniela.schaefer");
  await page.getByRole("banner").getByRole("link", { name: "Handbuch", exact: true }).click();
  await expect(page.getByRole("link", { name: "E2E Mittagessen bestellen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fundsachen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kopierer im Lehrerzimmer" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Seite anlegen" })).toHaveCount(0);
  expect((await page.goto("/hilfe/kopierer-im-lehrerzimmer"))?.status()).toBe(404);
  expect((await page.goto("/hilfe/neu"))?.status()).toBe(404);
  errors.length = 0; // die beiden 404 sind gewollt
  await page.goto("/hilfe");
  await page.getByRole("searchbox", { name: "Handbuch durchsuchen" }).fill("Mittagessen");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/hilfe\?q=Mittagessen/);
  await page.getByRole("region", { name: "Suchergebnisse" }).getByRole("link", { name: /E2E Mittagessen bestellen/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "E2E Mittagessen bestellen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Bearbeiten" })).toHaveCount(0);
  await page.getByRole("link", { name: "Fundsachen" }).click();
  await expect(page).toHaveURL(/\/hilfe\/fundsachen$/);
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Wohin möchtest du/).fill("Mittagessen");
  await page.getByRole("option", { name: /E2E Mittagessen bestellen/ }).click();
  await expect(page).toHaveURL(/\/hilfe\/e2e-mittagessen-bestellen$/);
  // die Personal-Seite findet die Suche für Eltern nicht
  await page.goto("/hilfe?q=Kopierer");
  await expect(page.getByText("Keine Seiten zu „Kopierer“")).toBeVisible();

  // schmal und dunkel: kein seitliches Scrollen, axe ohne Befund
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  for (const url of ["/hilfe", "/hilfe/e2e-mittagessen-bestellen"]) {
    await p.goto(url);
    await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await axeClean(p);
  }
  await p.screenshot({ path: ".data/shots/e2e/handbuch-eltern-360-dunkel.png", fullPage: true });
  await narrow.close();
  expect(narrowErrors).toEqual([]);

  // Lea (Schülerin) sieht die Eltern-Seite nicht
  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  expect((await page.goto("/hilfe/e2e-mittagessen-bestellen"))?.status()).toBe(404);
  expect(errors).toEqual([expect.stringContaining("404")]);
  errors.length = 0;

  // Ansprechperson bearbeitet die eigene Seite (nur Titel und Text)
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto("/hilfe/e2e-mittagessen-bestellen");
  await page.getByRole("link", { name: "Bearbeiten" }).click();
  const own = page.getByRole("form", { name: "Handbuchseite" });
  await expect(own.getByLabel("Status")).toHaveCount(0);
  await own.getByLabel("Text", { exact: true }).fill("Bestellung bis Donnerstag, 12 Uhr.");
  await own.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Bestellung bis Donnerstag, 12 Uhr.")).toBeVisible();
  await page.getByRole("button", { name: "Geprüft, unverändert" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Als geprüft vermerkt." })).toBeVisible();
  await expect(page.getByRole("button", { name: /löschen/i })).toHaveCount(0);

  // aufräumen: Seite und Bereich löschen (hilfe.manage)
  await logoutForSwitch(page);
  await login(page, "sabine.kowalski");
  await page.goto("/hilfe/e2e-mittagessen-bestellen");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Löschen" }).click();
  await expect(page).toHaveURL(/\/hilfe$/);
  await page.goto("/hilfe/bereiche");
  await page.getByRole("button", { name: "E2E Elterninfos löschen" }).click();
  await expect(page.getByRole("form", { name: "Bereich E2E Elterninfos" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
