import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP3-02: Arbeiten im Entwurf – Quelle wählen („Gültiger Plan“ · „Entwurf x.0“), Stunde im Entwurf löschen und mit der Setzhilfe neu setzen,
// Solver-Lauf im Entwurf und „In den Entwurf übernehmen“ (F-10-1), Änderungen zum gültigen Plan je Lehrkraft/Klasse, Variantenvergleich;
// der gültige Plan bleibt unverändert. Diff-Seite und Pflege im Entwurf mit axe, schmal (360 px) und dunkel. Räumt auf (Entwürfe verworfen,
// Lauf gelöscht).
const tag = Date.now().toString(36);
const NAME = `E2E Entwurf ${tag}`;
const RUN = `E2E Lauf im Entwurf ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

// Die Links „Setzen: …“ der offenen Stunden (seit P2b-12) haben einen eigenen Namen statt des sichtbaren Texts (axe best-practice
// „label-content-name-mismatch“) – andere Specs bedienen genau diese Namen; hier deshalb ausgenommen, nicht Teil von SP3-02.
async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").exclude('[aria-labelledby="open-title"] ul').analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("SP3-02: Quelle wählen, Stunde im Entwurf setzen, Lauf in den Entwurf übernehmen, Änderungen ansehen – gültiger Plan bleibt", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // gültiger Plan der 7b vorher
  const plan = page.getByRole("table", { name: "Stundenplan Klasse 7b" });
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  const liveBefore = await plan.innerText();

  // Entwurf aus dem gültigen Plan ab dem vorgeschlagenen Stichtag
  await page.goto("/planung/versionen");
  const form = page.getByRole("form", { name: "Entwurf anlegen" });
  await form.getByLabel("Name").fill(NAME);
  await form.getByRole("button", { name: "Entwurf anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${NAME}“ angelegt` })).toBeVisible();
  const card = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME}$`) });
  await card.getByRole("link", { name: "Im Entwurf arbeiten" }).click();
  await expect(page).toHaveURL(/\/planung\/stundenplan\?quelle=[\w-]+$/);
  const draftId = new URL(page.url()).searchParams.get("quelle")!;
  await expect(page.getByTestId("entwurf-hinweis")).toContainText(NAME);

  // Quellen-Wähler: Klasse wählen, der Entwurf bleibt eingestellt
  await expect(page.getByLabel("Plan", { exact: true })).toHaveValue(draftId);
  await page.getByLabel("Klasse oder Kurs").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await expect(page).toHaveURL(new RegExp(`gruppe=g-7b&quelle=${draftId}`));
  await expect(plan).toBeVisible();
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();

  // Stunde im Entwurf löschen → offen → mit der Setzhilfe in ein freies Feld setzen
  const openDeutsch = page.getByRole("link", { name: /^Setzen: Deutsch/ });
  const openBefore = await openDeutsch.count();
  await plan.getByRole("link", { name: /^Deutsch BRA/ }).first().click();
  await expect(page.getByRole("heading", { name: /^Stunde bearbeiten/ })).toBeVisible();
  await page.getByRole("button", { name: "Stunde löschen" }).click();
  await expect(openDeutsch.first()).toBeVisible();
  await openDeutsch.first().click();
  const place = page.getByRole("button", { name: /^Hier setzen: / });
  await expect(place.first()).toBeVisible();
  await place.last().click();
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();
  await expect(openDeutsch).toHaveCount(openBefore);
  await axe(page, "Pflege im Entwurf");
  await page.screenshot({ path: ".data/shots/e2e/planung-entwurf-pflege.png", fullPage: true });

  // der gültige Plan ist unverändert
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  await expect(page.getByTestId("entwurf-hinweis")).toHaveCount(0);
  expect(await plan.innerText()).toBe(liveBefore);

  // Diagnose/Verteilung gegen den Entwurf
  await page.goto(`/planung/unterricht?ansicht=diagnose&quelle=${draftId}`);
  await expect(page.getByText(`(Stunden im Entwurf`, { exact: false })).toBeVisible();

  // Lauf im Entwurf (Vorauswahl über die Quelle) → In den Entwurf übernehmen
  await page.goto(`/planung/solver?quelle=${draftId}`);
  const start = page.getByRole("form", { name: "Lauf starten" });
  await expect(start.getByLabel("Planen im")).toHaveValue(draftId);
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
  // im Entwurf gerechnet: Ziel ist der Entwurf, direkt in den gültigen Plan geht es nicht
  await expect(apply.getByLabel("Entwurf", { exact: true })).toHaveValue(draftId);
  await expect(page.locator("details").filter({ hasText: "direkt in den gültigen Plan" })).toHaveCount(0);
  await apply.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
  await expect(page).toHaveURL(/entwurf=[\w-]+/);
  const done = page.getByRole("status").filter({ hasText: "in den Entwurf" });
  await expect(done).toContainText("Der gültige Plan ist unverändert.");
  await expect(page.getByRole("button", { name: "Lauf löschen" })).toBeVisible();

  // Änderungen zum gültigen Plan je Lehrkraft und je Klasse
  await done.getByRole("link", { name: "Änderungen zum gültigen Plan" }).click();
  await expect(page.getByRole("heading", { name: /^Änderungen · Version \d+\.0$/, level: 1 })).toBeVisible();
  await expect(page.getByRole("list", { name: "Zusammenfassung" })).toContainText(/geändert: \d+/);
  await expect(page.getByTestId("diff-liste").getByRole("listitem").first()).toBeVisible();
  await page.getByRole("link", { name: "Je Klasse/Kurs" }).click();
  const klasse = page.getByTestId("diff-liste").locator("details").filter({ hasText: /^Klasse 7b/ });
  await klasse.locator("summary").click();
  await expect(klasse.getByRole("listitem").first()).toBeVisible();
  await axe(page, "Änderungen");
  await page.screenshot({ path: ".data/shots/e2e/planung-entwurf-aenderungen.png", fullPage: true });
  const diffUrl = page.url();

  // schmal und dunkel: Änderungen und Pflege im Entwurf ohne axe-Befund und ohne seitliches Scrollen
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  for (const url of [diffUrl, `/planung/stundenplan?gruppe=g-7b&quelle=${draftId}`]) {
    await p.goto(url);
    await expect(p.getByRole("main")).toBeVisible();
    await axe(p, `${url} (360 px, dunkel)`);
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  }
  await p.screenshot({ path: ".data/shots/e2e/planung-entwurf-mobil-dunkel.png", fullPage: true });
  await narrow.close();

  // gültiger Plan weiterhin unverändert
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  expect(await plan.innerText()).toBe(liveBefore);

  // Variante anlegen und vergleichen (Quelle „Version“)
  await page.goto("/planung/versionen");
  await card.getByRole("button", { name: "Variante anlegen" }).click();
  const variant = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME} – Variante$`) });
  await expect(variant).toBeVisible();
  await page.getByRole("link", { name: "Varianten vergleichen" }).click();
  const table = page.getByRole("table", { name: /Kennzahlen der verglichenen Versionen/ });
  await expect(table.getByRole("row", { name: /^Wochenstunden/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: new RegExp(`${NAME} – Variante`) })).toBeVisible();
  await axe(page, "Variantenvergleich");

  // aufräumen: Lauf löschen, Variante und Entwurf verwerfen
  await page.goto(runUrl);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Lauf löschen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\?geloescht=1$/);
  await page.goto("/planung/versionen");
  for (const article of [variant, card]) {
    page.once("dialog", (d) => void d.accept());
    await article.getByRole("button", { name: "Verwerfen" }).click();
    await expect(article.getByText("verworfen", { exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
