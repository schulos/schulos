import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { collectErrors, login } from "./helpers";

// RS-08/RS-09: Raumlayout per Tastatur anlegen (Sekretariat, Recht „Raumdaten pflegen“), Sitzplan aus dem Layout als Kopie
// (Lehrkraft), spätere Layoutänderung lässt den Sitzplan unverändert (Hinweis), Ansicht 360 px dunkel mit axe, Schülerin
// sieht nichts, Druck. Fester Raum NW3 (im Demo-Seed ohne Layout, sonst in keinem Spec); räumt Plan und Layout wieder weg.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const PLAN = "7b Physik aus Layout (E2E)";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("RS-08/09: Layout per Tastatur anlegen, Sitzplan als Kopie, Änderung lässt den Sitzplan unverändert, 360 px dunkel, aufräumen", async ({ page, browser }) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());

  // Sekretariat legt das Standard-Layout für NW3 an
  await login(page, "sabine.kowalski");
  await page.goto("/raeume/NW3");
  const card = page.getByRole("article", { name: "Raumlayout" });
  await expect(card.getByText("Noch kein Layout eingetragen.")).toBeVisible();
  await card.getByRole("link", { name: "Layouts bearbeiten" }).click();
  await expect(page).toHaveURL(/\/raeume\/NW3\/layout$/);
  await page.getByRole("link", { name: "Neues Layout" }).click();
  const editor = page.getByRole("region", { name: "Layout bearbeiten" });
  await expect(editor.getByLabel("Name")).toHaveValue("Standard");
  await editor.getByLabel("Reihen").fill("3");
  await editor.getByLabel("Spalten").fill("4");
  await editor.getByRole("button", { name: "Raster übernehmen" }).click();
  await expect(editor.getByRole("group", { name: "Raster 3 × 4" })).toBeVisible();

  // Tastatur: Fokus ins Raster, Enter setzt das gewählte Element (Platz), Pfeiltasten bewegen, Entf leert
  await editor.getByRole("button", { name: "Reihe 1, Spalte 1: frei" }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("button", { name: "Reihe 1, Spalte 1: Platz" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(editor.getByRole("button", { name: "Reihe 1, Spalte 2: frei" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(editor.getByRole("button", { name: "Reihe 1, Spalte 4: Tafel/Display" })).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(editor.getByRole("button", { name: "Reihe 1, Spalte 4: frei" })).toBeFocused();
  // Element wechseln (Radiogruppe, Tastatur) und hinten rechts eine Tür setzen
  await editor.getByRole("radio", { name: "Tür" }).focus();
  await page.keyboard.press("Space");
  await expect(editor.getByRole("radio", { name: "Tür" })).toBeChecked();
  await editor.getByRole("button", { name: "Reihe 3, Spalte 4: Platz" }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("button", { name: "Reihe 3, Spalte 4: Tür" })).toBeVisible();
  await expect(editor.getByTestId("layout-plaetze")).toContainText("7 Plätze");
  await expect(editor.getByText(/in den Stammdaten 28/)).toBeVisible();
  await editor.getByRole("button", { name: "Layout anlegen" }).click();
  await expect(page).toHaveURL(/\/raeume\/NW3\/layout\?l=.+&gespeichert=1/);
  await expect(page.getByRole("status").filter({ hasText: "Layout angelegt." })).toBeVisible();
  await expect(page.getByTestId("layout-fakten")).toContainText("Standard-Layout · Variante Reihen · Raster 3 × 4 · 7 Plätze");
  await axeClean(page);
  const layoutUrl = page.url();

  // Lehrkraft legt einen Sitzplan aus dem Layout an (Kopie)
  const teacherCtx = await browser.newContext();
  const t = await teacherCtx.newPage();
  const teacherErrors = collectErrors(t);
  t.on("dialog", (d) => void d.accept());
  await login(t, "jana.brandt");
  await t.goto("/sitzplan");
  const form = t.getByRole("form", { name: "Neuer Sitzplan" });
  await form.getByLabel("Lerngruppe").selectOption({ label: "Klasse 7b" });
  await form.getByLabel("Titel").fill(PLAN);
  await form.getByLabel("Fach").selectOption("");
  await form.getByLabel("Raum").selectOption("");
  await form.getByLabel("Tischanordnung").selectOption({ label: "NW3 – Standard (Standard), 7 Plätze" });
  await expect(form.getByLabel("Reihen", { exact: true })).toBeDisabled();
  await form.getByRole("button", { name: "Sitzplan anlegen" }).click();
  await expect(t.getByRole("heading", { name: PLAN })).toBeVisible();
  const planPath = new URL(t.url()).pathname;
  await expect(t.getByTestId("sitzplan-raumlayout")).toContainText("Tische als Kopie aus dem Raumlayout „Standard“ (Raum NW3)");
  await expect(t.getByTestId("sitzplan-raumlayout")).not.toContainText("seitdem geändert");
  const freeDesks = t.getByRole("button", { name: /^Reihe \d+, Platz \d+: frei$/ });
  await expect(freeDesks).toHaveCount(7);
  await expect(t.getByRole("button", { name: "Reihe 1, Platz 1: frei" })).toBeVisible();
  await expect(t.getByRole("button", { name: "Reihe 3, Platz 4: kein Tisch" })).toBeDisabled();

  // Sekretariat ändert das Layout (ein Platz mehr) – der Sitzplan bleibt, wie er ist
  await page.goto(layoutUrl);
  const edit = page.getByRole("region", { name: "Layout bearbeiten" });
  await edit.getByRole("button", { name: "Reihe 1, Spalte 4: frei" }).click();
  await expect(edit.getByTestId("layout-plaetze")).toContainText("8 Plätze");
  await edit.getByRole("button", { name: "Layout speichern" }).click();
  await expect(edit.getByRole("status")).toHaveText("Layout gespeichert.");
  await t.reload();
  await expect(t.getByTestId("sitzplan-raumlayout")).toContainText("Das Raumlayout wurde seitdem geändert – dieser Sitzplan bleibt, wie er ist.");
  await expect(freeDesks).toHaveCount(7);

  // Ansicht für Lehrkraft (nicht verantwortlich): 360 px dunkel, nur lesen, Raster scrollt im Kasten
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const n = await narrow.newPage();
  const narrowErrors = collectErrors(n);
  await login(n, "jana.brandt");
  await n.goto("/raeume/NW3");
  const view = n.getByRole("article", { name: "Raumlayout" });
  await expect(view).toContainText("Standard · 8 Plätze");
  await expect(view.getByRole("table", { name: /Raumlayout Standard, Raum NW3/ })).toBeVisible();
  await expect(view.getByRole("cell", { name: "Reihe 3, Spalte 4: Tür" })).toBeVisible();
  await view.getByRole("link", { name: "Alle Layouts" }).click();
  await expect(n).toHaveURL(/\/raeume\/NW3\/layout$/);
  await expect(n.getByRole("region", { name: "Layout bearbeiten" })).toHaveCount(0);
  await expect(n.getByRole("table", { name: /Raumlayout Standard/ })).toBeVisible();
  expect(await n.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(n);
  await n.screenshot({ path: ".data/shots/e2e/raumlayout-lehrkraft-360-dunkel.png", fullPage: true });
  await n.goto("/raeume/NW3");
  expect(await n.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(n);

  // Druck des Layouts
  await page.goto("/druck/raum/NW3/layout");
  await expect(page.getByRole("heading", { name: /NW3.*Standard/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Reihe 3, Spalte 4: Tür" })).toBeVisible();

  // Schülerin: kein Layout, Seite 404
  const studentCtx = await browser.newContext();
  const s = await studentCtx.newPage();
  await login(s, "lea.schaefer");
  await s.goto("/raeume/NW3");
  await expect(s.getByRole("article", { name: "Überblick" })).toBeVisible();
  await expect(s.getByRole("article", { name: "Raumlayout" })).toHaveCount(0);
  expect((await s.request.get("/raeume/NW3/layout")).status()).toBe(404);
  expect((await s.request.get("/druck/raum/NW3/layout")).status()).toBe(404);

  // aufräumen: Sitzplan und Layout löschen
  await t.goto(planPath);
  await t.getByRole("button", { name: "Sitzplan löschen" }).click();
  await expect(t).toHaveURL(/\/sitzplan$/);
  await page.goto(layoutUrl);
  await page.getByRole("button", { name: "Layout löschen" }).click();
  await expect(page).toHaveURL(/\/raeume\/NW3\/layout$/);
  await expect(page.getByText("Noch kein Layout")).toBeVisible();

  expect(errors).toEqual([]);
  expect(teacherErrors).toEqual([]);
  expect(narrowErrors).toEqual([]);
  await Promise.all([teacherCtx.close(), narrow.close(), studentCtx.close()]);
});
