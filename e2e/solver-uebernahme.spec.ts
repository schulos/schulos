import AxeBuilder from "./axe";
import { expect, test } from "@playwright/test";
import { approveVersion, collectErrors, deDate, login, publishVersionAt, undoAndDiscardVersion } from "./helpers";

// SP-09/SP-13 auf dem Versionsweg (SP3-04, F-10-1): ein Lauf geht in einen neuen Entwurf ab Stichtag (Schultag) → Prüfung/Freigabe →
// „Ab … veröffentlichen“ → der Plan zeigt ab dem Stichtag die neuen Stunden → bis zum Stichtag zurücknehmen → alter Stand. Eine
// Vertretung (Entfall) am Stichtag zieht beim Veröffentlichen mit oder wird gesichert und ist nach dem Zurücknehmen wieder an ihrer Stunde.
// Die frühere direkte Übernahme in den gültigen Plan gibt es nicht mehr; der Weg in den Entwurf steht auch in `planung-entwurf.spec.ts`.

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
const isoOf = (de: string) => `${de.slice(6, 10)}-${de.slice(3, 5)}-${de.slice(0, 2)}`;

test("SP-09/SP-13 über SP3-04: Lauf → Entwurf → veröffentlichen ab Stichtag → Plan ab Stichtag neu → zurücknehmen → alter Stand mit Vertretung", async ({ page, browser }) => {
  test.setTimeout(240_000);
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
  // die direkte Übernahme in den gültigen Plan gibt es nicht mehr
  await expect(page.getByRole("form", { name: "Vorschlag übernehmen" })).toHaveCount(0);

  // Stichtag muss ein Schultag sein: ein Sonntag wird abgelehnt, der Fehler nennt den nächsten Schultag
  const toDraft = page.getByRole("form", { name: "In den Entwurf übernehmen" });
  await toDraft.getByLabel("Entwurf", { exact: true }).selectOption("neu");
  await toDraft.getByLabel("Stichtag (nur neuer Entwurf)").fill(sundayIn(8));
  await toDraft.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "kein Schultag" });
  await expect(alert).toContainText("kein Schultag (Wochenende)");
  const from = isoOf((await alert.textContent())!.match(/nächster Schultag: (\d{2}\.\d{2}\.\d{4})/)![1]!);

  // SP-13: Entfall für eine Stunde der 7b am Stichtag
  const subsUrl = `/planung/vertretungen?datum=${from}&gruppe=g-7b`;
  const lessons = page.getByRole("region", { name: /^Stunden am/ });
  await page.goto(subsUrl);
  const subLabel = (await lessons.getByRole("form").filter({ hasNot: page.getByRole("button", { name: "Aufheben" }) }).first().getAttribute("aria-label"))!;
  const subForm = lessons.getByRole("form", { name: subLabel, exact: true });
  await subForm.getByRole("radio", { name: "Entfall" }).check();
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

  // Lauf in einen neuen Entwurf ab Stichtag – der gültige Plan bleibt
  await page.goto(url);
  await toDraft.getByLabel("Entwurf", { exact: true }).selectOption("neu");
  await toDraft.getByLabel("Stichtag (nur neuer Entwurf)").fill(from);
  await toDraft.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
  await expect(page).toHaveURL(/[?&]entwurf=[\w-]+/);
  const versionId = new URL(page.url()).searchParams.get("entwurf")!;
  await page.goto(planUrl);
  expect(await plan.innerText()).toBe(before);

  // Prüfung und Freigabe (Schulleitung), Vorschau der Veröffentlichung mit Zahlen
  await approveVersion(page, browser, versionId);
  await page.goto(`/planung/versionen/veroeffentlichen?version=${versionId}&ab=${from}`);
  await expect(page.getByTestId("zahl-geändert")).toHaveText(/^\d+$/);
  await expect(page.getByTestId("vertretungen")).toContainText("Vertretungen ab dem Stichtag:");
  await expect(page.getByRole("button", { name: `Ab ${deDate(from)} veröffentlichen` })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // veröffentlichen → zurücknehmbar bis zum Stichtag; der Plan zeigt ab dem Stichtag den Vorschlag
  await publishVersionAt(page, versionId, from);
  await expect(page.getByRole("heading", { name: "Veröffentlichung zurücknehmen" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Was beim Zurücknehmen zu beachten ist" })).toContainText(/zurück an die bisherige Stunde/);
  await page.goto(planUrl);
  await expect(plan).toBeVisible();
  expect(await plan.innerText()).not.toBe(before);
  await page.screenshot({ path: ".data/shots/e2e/solver-uebernahme.png", fullPage: true });
  // der Lauf bleibt „fertig“ (in weitere Entwürfe übernehmbar)
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Übernehmen" })).toBeVisible();

  // zurücknehmen (mit Rückfrage) → alter Plan, der Entfall ist wieder an seiner Stunde – aufheben; Version verwerfen
  await undoAndDiscardVersion(page, versionId);
  await page.goto(planUrl);
  await expect(plan).toBeVisible();
  expect(await plan.innerText()).toBe(before);
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
