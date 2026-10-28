import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SQ-02: „Ab aktuellem Entwurf verbessern“ – Entwurf anlegen, eine Stunde darin löschen (offen), Lauf mit Vorgehen „verbessern“ starten
// (nur bei Quelle Entwurf wählbar), Protokoll zeigt Start aus dem Entwurf und Startbewertung → Endbewertung mit Runden, Übernahme in den
// Entwurf und Änderungen zum gültigen Plan. Lauf-Seite mit axe, schmal (360 px) und dunkel. Räumt auf (Lauf gelöscht, Entwurf verworfen).
const tag = Date.now().toString(36);
const NAME = `E2E Warmstart ${tag}`;
const RUN = `E2E verbessern ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("SQ-02: Lauf „ab aktuellem Entwurf verbessern“ – Start aus dem Entwurf, Protokoll, Übernahme in den Entwurf, Änderungen", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // Entwurf aus dem gültigen Plan, darin eine Stunde der 7b löschen (sie ist danach offen)
  await page.goto("/planung/versionen");
  const form = page.getByRole("form", { name: "Entwurf anlegen" });
  await form.getByLabel("Name").fill(NAME);
  await form.getByRole("button", { name: "Entwurf anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${NAME}“ angelegt` })).toBeVisible();
  const card = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME}$`) });
  await card.getByRole("link", { name: "Im Entwurf arbeiten" }).click();
  await expect(page).toHaveURL(/\/planung\/stundenplan\?quelle=[\w-]+$/);
  const draftId = new URL(page.url()).searchParams.get("quelle")!;
  await page.goto(`/planung/stundenplan?gruppe=g-7b&quelle=${draftId}`);
  const plan = page.getByRole("table", { name: "Stundenplan Klasse 7b" });
  const openDeutsch = page.locator('[aria-labelledby="open-title"]').getByRole("link", { name: /^Deutsch/ });
  const openBefore = await openDeutsch.count();
  await plan.getByRole("link", { name: /^Deutsch BRA/ }).first().click();
  await page.getByRole("button", { name: "Stunde löschen" }).click();
  await expect(openDeutsch).toHaveCount(openBefore + 1);

  // „verbessern“ gibt es nur im Entwurf
  await page.goto("/planung/solver");
  const start = page.getByRole("form", { name: "Lauf starten" });
  await expect(start.getByLabel("Planen im")).toHaveValue("gueltig");
  await expect(start.getByLabel("Vorgehen")).toHaveCount(0);
  await start.getByLabel("Planen im").selectOption(draftId);
  await expect(start.getByLabel("Vorgehen")).toHaveValue("neu");
  await expect(start.getByLabel("Ändern dürfen")).toHaveCount(0);
  await start.getByLabel("Vorgehen").selectOption("entwurf");
  await expect(start.getByLabel("Ändern dürfen")).toHaveValue("alle");
  await start.getByLabel("Bezeichnung").fill(RUN);
  await start.getByLabel("Gründlichkeit").selectOption("schnell");
  await start.getByRole("button", { name: "Plan berechnen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\/[\w-]+$/);
  const runUrl = page.url();
  const apply = page.getByRole("form", { name: "In den Entwurf übernehmen" });
  await expect(async () => {
    await page.reload();
    await expect(apply).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 150_000 });

  // Parameter, Kennzahlen und Protokoll: Start aus dem Entwurf, die offene Stunde ist wieder gesetzt
  await expect(page.getByText("ab aktuellem Entwurf verbessern (alles außer Fixiertem)")).toBeVisible();
  await expect(page.getByText(/^nicht gesetzt [1-9]\d* → 0, \d+ von \d+ Einheiten des Entwurfs unverändert$/)).toBeVisible();
  await expect(page.getByText(/^\d+ Runden, \d+ übernommen/)).toBeVisible();
  await expect(page.getByText(/Start aus dem Entwurf: \d+ von \d+ Einheiten übernommen, [1-9]\d* nicht gesetzt/)).toBeVisible();
  await expect(page.getByText(/Fertig: Bewertung \d+ → \d+, nicht gesetzt [1-9]\d* → 0, \d+ Runden \(\d+ Verbesserungen übernommen\)/)).toBeVisible();
  await axe(page, "Lauf ab Entwurf");
  await page.screenshot({ path: ".data/shots/e2e/planung-warmstart-lauf.png", fullPage: true });

  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  await p.goto(runUrl);
  await expect(p.getByRole("main")).toBeVisible();
  await axe(p, "Lauf ab Entwurf (360 px, dunkel)");
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await p.screenshot({ path: ".data/shots/e2e/planung-warmstart-mobil-dunkel.png", fullPage: true });
  await narrow.close();

  // Übernahme in den Entwurf (SP3-02-Weg) und Änderungen zum gültigen Plan
  await expect(apply.getByLabel("Entwurf", { exact: true })).toHaveValue(draftId);
  await apply.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
  const done = page.getByRole("status").filter({ hasText: "in den Entwurf" });
  await expect(done).toContainText("Der gültige Plan ist unverändert.");
  await done.getByRole("link", { name: "Änderungen zum gültigen Plan" }).click();
  await expect(page.getByRole("heading", { name: /^Änderungen · Version \d+\.0$/, level: 1 })).toBeVisible();
  await expect(page.getByRole("list", { name: "Zusammenfassung" })).toBeVisible();

  // im Entwurf ist nichts mehr offen
  await page.goto(`/planung/stundenplan?gruppe=g-7b&quelle=${draftId}`);
  await expect(openDeutsch).toHaveCount(openBefore);

  // aufräumen: Lauf löschen, Entwurf verwerfen
  await page.goto(runUrl);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Lauf löschen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\?geloescht=1$/);
  await page.goto("/planung/versionen");
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Verwerfen" }).click();
  await expect(card.getByText("verworfen", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
