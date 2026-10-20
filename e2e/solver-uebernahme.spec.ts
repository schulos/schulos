import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP-09 (docs/STUNDENPLAN-UMBAU.md §3.2, „Umsetzungsstand SP-09“): Lauf ab einem Stichtag (Schultag) übernehmen → der Plan zeigt ab dem
// Stichtag die neuen Stunden → der Lauf ist bis zum Stichtag nicht löschbar → Übernahme zurücknehmen → alter Stand.
// SP-13: eine Vertretung (Entfall) am Stichtag entfällt mit der Übernahme und ist nach dem Zurücknehmen wieder da.

const tag = Date.now().toString(36);
const LABEL = `E2E Übernahme ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Sonntag in etwa `weeks` Wochen – weit genug weg, damit Vertretungen der nächsten Tage (andere Specs) unberührt bleiben. */
function sundayIn(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  return ymd(d);
}

test("SP-09/SP-13: Lauf ab Stichtag übernehmen → Plan ab Stichtag neu → nicht löschbar → zurücknehmen → alter Stand mit Vertretung", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // schneller Lauf, fertig abwarten
  await page.goto("/planung/solver");
  const form = page.getByRole("form", { name: "Lauf starten" });
  await form.getByLabel("Bezeichnung").fill(LABEL);
  await form.getByLabel("Gründlichkeit").selectOption("schnell");
  await form.getByRole("button", { name: "Plan berechnen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\/[\w-]+$/);
  const url = page.url();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Übernehmen" })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 90_000 });
  // Hinweis, was die Übernahme ab dem vorgeschlagenen Stichtag ändert
  await expect(page.getByTestId("apply-preview")).toContainText(/Stunden? end(et|en) am Vortag/);

  // Stichtag muss ein Schultag sein: ein Sonntag wird abgelehnt, der Fehler nennt den nächsten Schultag
  const sunday = sundayIn(8);
  const applyForm = page.getByRole("form", { name: "Vorschlag übernehmen" });
  await applyForm.getByLabel("ab Stichtag").fill(sunday);
  await applyForm.getByRole("button", { name: "Ab Stichtag übernehmen" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Stichtag" });
  await expect(alert).toContainText("kein Schultag (Wochenende)");
  const from = (await alert.textContent())!.match(/nächster Schultag: (\d{4}-\d{2}-\d{2})/)![1]!;

  // SP-13: Entfall für eine Stunde der 7b am Stichtag
  const subsUrl = `/planung/vertretungen?datum=${from}&gruppe=g-7b`;
  const lessons = page.getByRole("region", { name: /^Stunden am/ });
  await page.goto(subsUrl);
  const subLabel = (await lessons.getByRole("form").filter({ hasNot: page.getByRole("button", { name: "Aufheben" }) }).first().getAttribute("aria-label"))!;
  const subForm = lessons.getByRole("form", { name: subLabel, exact: true });
  await subForm.getByLabel("Art").selectOption("cancel");
  await subForm.getByRole("button", { name: "Speichern" }).click();
  await expect(subForm.getByRole("status")).toContainText("Gespeichert");
  await page.goto(subsUrl);
  await expect(subForm.getByRole("button", { name: "Aufheben" })).toBeVisible();

  // Plan der 7b am Stichtag vorher merken
  const planUrl = `/planung/stundenplan?gruppe=g-7b&stand=${from}`;
  const plan = page.getByRole("table", { name: "Stundenplan Klasse 7b" });
  await page.goto(planUrl);
  await expect(plan).toBeVisible();
  const before = await plan.innerText();

  // übernehmen
  await page.goto(url);
  await applyForm.getByLabel("ab Stichtag").fill(from);
  await applyForm.getByRole("button", { name: "Ab Stichtag übernehmen" }).click();
  await expect(page).toHaveURL(/uebernommen=\d+/);
  await expect(page.getByRole("status").filter({ hasText: /\d+ Stunden übernommen/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Bis zum Stichtag lässt sich die Übernahme zurücknehmen" })).toBeVisible();
  // Löschsperre: kein Lösch-Knopf, dafür die Rücknahme mit Erklärung
  await expect(page.getByRole("button", { name: "Lauf löschen" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Übernahme zurücknehmen" })).toBeVisible();
  await expect(page.getByText(/beendete Stunden gelten wieder bis zu ihrem früheren Ende/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Was beim Zurücknehmen zu beachten ist" })).toContainText(/\d+ bei der Übernahme entfernte Vertretunge?n? (wird|werden) wiederhergestellt/);
  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  // Historie: übernommen ab Stichtag, zurücknehmbar
  await page.goto("/planung/solver");
  const row = page.getByRole("table", { name: /Läufe der automatischen Planung/ }).getByRole("row").filter({ has: page.getByRole("link", { name: LABEL }) });
  await expect(row).toContainText("übernommen");
  await expect(row).toContainText("zurücknehmbar");
  // die Vertretung ist mit der Übernahme entfallen (ihre Stunde gilt ab dem Stichtag nicht mehr)
  await page.goto(subsUrl);
  await expect(lessons.getByRole("form", { name: subLabel, exact: true }).getByRole("button", { name: "Aufheben" })).toHaveCount(0);
  // der Plan zeigt ab dem Stichtag den Vorschlag (anders als vorher), vor dem Stichtag unverändert
  await page.goto(planUrl);
  await expect(plan).toBeVisible();
  expect(await plan.innerText()).not.toBe(before);
  await page.screenshot({ path: ".data/shots/e2e/solver-uebernahme.png", fullPage: true });

  // zurücknehmen (mit Rückfrage) → wieder „fertig“, löschbar, alter Plan
  await page.goto(url);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Übernahme zurücknehmen" }).click();
  await expect(page).toHaveURL(/zurueckgenommen=\d+/);
  await expect(page.getByRole("status").filter({ hasText: "Übernahme zurückgenommen" })).toContainText(/Vertretunge?n? wiederhergestellt/);
  await expect(page.getByRole("heading", { name: "Übernehmen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lauf löschen" })).toBeVisible();
  await expect(page.getByText(/Zurückgenommen/).first()).toBeVisible();
  await page.goto(planUrl);
  await expect(plan).toBeVisible();
  expect(await plan.innerText()).toBe(before);
  // SP-13: der Entfall ist wieder da – aufheben
  await page.goto(subsUrl);
  const back = lessons.getByRole("form", { name: subLabel, exact: true });
  await expect(back.getByRole("button", { name: "Aufheben" })).toBeVisible();
  await back.getByRole("button", { name: "Aufheben" }).click();
  await expect(back.getByRole("button", { name: "Aufheben" })).toHaveCount(0);

  // aufräumen
  await page.goto(url);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Lauf löschen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\?geloescht=1$/);
  expect(errors).toEqual([]);
});
