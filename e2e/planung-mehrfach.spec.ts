import AxeBuilder from "./axe";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SQ-03: Mehrfachlauf – Entwurf anlegen, Lauf mit „Mehrfachlauf“ und 3 Durchgängen starten, Lauf-Seite zeigt die Tabelle „Durchgänge“ mit
// markiertem bestem Durchgang und je Durchgang eine Protokollzeile, Übernahme in den Entwurf. Lauf-Seite mit axe. Räumt auf (Lauf gelöscht,
// Entwurf verworfen).
const tag = Date.now().toString(36);
const NAME = `E2E Mehrfach ${tag}`;
const RUN = `E2E Mehrfachlauf ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("SQ-03: Mehrfachlauf – Durchgänge in einem Lauf, bester Durchgang markiert, Übernahme in den Entwurf", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  await page.goto("/planung/versionen");
  const form = page.getByRole("form", { name: "Entwurf anlegen" });
  await form.getByLabel("Name").fill(NAME);
  await form.getByRole("button", { name: "Entwurf anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${NAME}“ angelegt` })).toBeVisible();
  const card = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME}$`) });
  await card.getByRole("link", { name: "Im Entwurf arbeiten" }).click();
  await expect(page).toHaveURL(/\/planung\/stundenplan\?quelle=[\w-]+$/);
  const draftId = new URL(page.url()).searchParams.get("quelle")!;

  // Formular: Durchgänge erscheinen erst beim Mehrfachlauf, Vorgabe 5
  await page.goto("/planung/solver");
  const start = page.getByRole("form", { name: "Lauf starten" });
  await expect(start.getByLabel("Läufe")).toHaveValue("einzel");
  await expect(start.getByLabel("Durchgänge")).toHaveCount(0);
  await start.getByLabel("Läufe").selectOption("mehrfach");
  await expect(start.getByLabel("Durchgänge")).toHaveValue("5");
  await start.getByLabel("Durchgänge").selectOption("3");
  await start.getByLabel("Planen im").selectOption(draftId);
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

  // Parameter, Tabelle der Durchgänge mit genau einem besten, Protokoll je Durchgang
  await expect(page.getByText("3 (Mehrfachlauf)")).toBeVisible();
  const table = page.getByRole("table", { name: /^Durchgänge des Mehrfachlaufs/ });
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByText("bester Durchgang")).toHaveCount(1);
  await expect(page.getByText(/^Durchgang 1 von 3 \(Startwert \d+\): Bewertung \d+/)).toBeVisible();
  await expect(page.getByText(/^Durchgang 3 von 3 \(Startwert \d+\): Bewertung \d+/)).toBeVisible();
  await expect(page.getByText(/Bester Durchgang: \d von 3 \(Startwert \d+\)\. Fertig:/)).toBeVisible();
  await axe(page, "Mehrfachlauf");
  await page.screenshot({ path: ".data/shots/e2e/planung-mehrfach-lauf.png", fullPage: true });

  // Übernahme in den Entwurf wie bisher
  await expect(apply.getByLabel("Entwurf", { exact: true })).toHaveValue(draftId);
  await apply.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "in den Entwurf" })).toContainText("Der gültige Plan ist unverändert.");

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
