import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// SP-07 (docs/STUNDENPLAN-UMBAU.md §3.2, §5): Solver-Läufe bedienen – Parameter inkl. eigener Gewichte (SP-G-16 „lateFrom“),
// Historie mit Kennzahlen und Filter, Status ohne Neuladen, Abbrechen, zweiter Lauf, Detailseite mit Vorprüfung/Protokoll, Löschen.

// eindeutige Bezeichnungen, damit Wiederholungen (--repeat-each) sich nicht in die Quere kommen
const tag = Date.now().toString(36);
const A = `E2E eigene ${tag}`;
const B = `E2E Variante B ${tag}`;
const C = `E2E Variante C ${tag}`;

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function startRun(page: Page, opts: { label: string; effort?: string; preset?: string; weights?: Record<string, string> }) {
  await page.goto("/planung/solver");
  const form = page.getByRole("form", { name: "Lauf starten" });
  await form.getByLabel("Bezeichnung").fill(opts.label);
  await form.getByLabel("Gründlichkeit").selectOption(opts.effort ?? "gruendlich");
  if (opts.preset) await form.getByLabel("Gewichtung").selectOption(opts.preset);
  for (const [label, value] of Object.entries(opts.weights ?? {})) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole("button", { name: "Plan berechnen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: opts.label, level: 1 })).toBeVisible();
  return page.url();
}

test("SP-07: Lauf mit eigenen Gewichten starten → weiterer Lauf abbrechen → Historie, Detailseite, Löschen", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // Eigene Gewichte: Formular zeigt alle Felder inkl. „Grenze späte Stunden“, vorbelegt mit der zuletzt gewählten Voreinstellung
  await page.goto("/planung/solver");
  const form = page.getByRole("form", { name: "Lauf starten" });
  await form.getByLabel("Gewichtung").selectOption("raumtreu");
  await expect(form.getByText(/Gewichte „raumtreu“: .*Ohne Raum 40/)).toBeVisible();
  await form.getByLabel("Gewichtung").selectOption("eigene");
  await expect(form.getByRole("group", { name: "Eigene Gewichte (0 bis 1000)" })).toBeVisible();
  await expect(form.getByLabel("Ohne Raum", { exact: true })).toHaveValue("40");
  await expect(form.getByLabel("Grenze späte Stunden", { exact: true })).toHaveValue("6");

  const first = await startRun(page, { label: A, effort: "schnell", preset: "eigene", weights: { "Grenze späte Stunden": "5", "Hohlstunde Lehrkraft": "7" } });
  // zwei gründliche Läufe hinterher: der letzte wartet, bis die anderen fertig sind – und wird abgebrochen
  await startRun(page, { label: B });
  const third = await startRun(page, { label: C });
  const cancel = page.getByRole("form", { name: "Lauf abbrechen" });
  await cancel.getByRole("button", { name: "Abbrechen" }).click();
  await expect(page).toHaveURL(third);
  // wartend → sofort abgebrochen; rechnete er schon, endet er vorzeitig mit gültigem Plan oder ohne Ergebnis
  await expect(page.getByText(/abgebrochen, bevor ein Plan entstand|Vorzeitig beendet bei \d+ %|Abbruch angefordert/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/abgebrochen, bevor ein Plan entstand|Vorzeitig beendet bei \d+ %/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Protokoll" })).toBeVisible();
  await expect(page.getByText(/Abgebrochen|Vorzeitig beendet/).last()).toBeVisible();

  // Historie: Kennzahlen je Lauf, Filter; der zweite Lauf rechnet trotz Abbruch des dritten zu Ende
  await page.getByRole("link", { name: "Alle Läufe" }).click();
  await expect(page).toHaveURL("/planung/solver");
  const table = page.getByRole("table", { name: /Läufe der automatischen Planung/ });
  const rowB = table.getByRole("row").filter({ has: page.getByRole("link", { name: B }) });
  await expect(async () => {
    await page.reload();
    await expect(rowB.getByText("fertig")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await expect(rowB).toContainText("gründlich · ausgewogen");
  const rowA = table.getByRole("row").filter({ has: page.getByRole("link", { name: A }) });
  await expect(rowA).toContainText("schnell · eigene");
  await expect(rowA.getByRole("cell").nth(4)).toHaveText("0");
  const filters = page.getByRole("navigation", { name: "Läufe filtern" });
  await filters.getByRole("link", { name: "Fertig" }).click();
  await expect(filters.getByRole("link", { name: "Fertig" })).toHaveAttribute("aria-current", "page");
  await expect(table.getByRole("link", { name: B })).toBeVisible();
  await filters.getByRole("link", { name: "Wartend/rechnend" }).click();
  await expect(page.getByText("Keine Läufe mit diesem Status")).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/solver-laeufe.png", fullPage: true });

  // Detailseite des ersten Laufs: Parameter mit eigener Grenze, Kennzahlen, Vorprüfung, Vorschau je Lehrkraft, Protokoll
  await page.goto(first);
  const params = page.getByRole("table", { name: "Gewichte des Laufs" });
  await expect(params.getByRole("row", { name: /Grenze späte Stunden 5/ })).toBeVisible();
  await expect(params.getByRole("row", { name: /Hohlstunde Lehrkraft 7/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kennzahlen" })).toBeVisible();
  await expect(page.getByText(/von \d+ gesetzt/)).toBeVisible();
  await expect(page.getByText("Bedarf passt überall in die freien, ungesperrten Slots.")).toBeVisible();
  await expect(page.getByText(/Fertig: Bewertung/)).toBeVisible();
  const costs = page.getByRole("navigation", { name: "Kostenposten filtern" });
  const firstCategory = costs.getByRole("link").nth(1);
  if (await firstCategory.count()) {
    await firstCategory.click();
    await expect(firstCategory).toHaveAttribute("aria-current", "page");
  }
  await page.getByLabel("Klasse, Kurs oder Lehrkraft").selectOption({ label: "BRA – Jana Brandt" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await expect(page.getByRole("table", { name: "Vorschlag BRA (Lehrkraft)" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Vorschlag BRA (Lehrkraft)" }).getByText(/Klasse 7b/).first()).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // Löschen mit Rückfrage
  await page.goto(third);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Lauf löschen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\?geloescht=1$/);
  await expect(page.getByRole("status").filter({ hasText: "Lauf gelöscht." })).toBeVisible();
  await expect(page.getByRole("link", { name: C })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect((await page.goto(third))?.status()).toBe(404);
});

test("SP-07: alte Links mit ?lauf= führen auf die Detailseite; unbekannter Lauf 404; Sekretariat ohne Zugriff auf die Status-Abfrage", async ({ page }) => {
  await login(page, "frank.schulte");
  await page.goto("/planung/solver");
  const href = await page.getByRole("table", { name: /Läufe der automatischen Planung/ }).getByRole("link").first().getAttribute("href");
  const id = href!.split("/").at(-1)!;
  await page.goto(`/planung/solver?lauf=${id}`);
  await expect(page).toHaveURL(`/planung/solver/${id}`);
  expect((await page.goto("/planung/solver/gibt-es-nicht"))?.status()).toBe(404);
  const ok = await page.request.get(`/api/stundenplan/solver/status?ids=${id}`);
  expect(ok.status()).toBe(200);
  expect((await ok.json()).runs[0]).toMatchObject({ id });

  await logoutForSwitch(page);
  await login(page, "sabine.kowalski");
  expect((await page.request.get(`/api/stundenplan/solver/status?ids=${id}`)).status()).toBe(403);
  expect((await page.goto(`/planung/solver/${id}`))?.status()).toBe(404);
});
