import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// SP3-07: Schuljahresabschluss + Übertrag auf der Versionsliste. Die E2E-Demo hat nur das Schuljahr 2026/27 (kein Vorjahr, kein Folgejahr) –
// Schuljahreswechsel, Hochstufen und Archivieren würden die gemeinsame DB für spätere Specs verändern; sie sind in `neues-schuljahr.test.ts`
// und `schuljahresabschluss.test.ts` abgedeckt. Hier nur lesend: Vorlage „Neues Schuljahr“ mit ihren Schritten, Kurzstatistik ohne Namen
// (Planung und Prüfung), Archiv-Hinweis vor dem Schuljahresende; axe hell und 360 px dunkel. Nichts hängt am Wochentag oder an der Uhrzeit.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("SP3-07: Vorlage „Neues Schuljahr“, Kurzstatistik ohne Namen und Archiv-Hinweis auf der Versionsliste", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/versionen");

  // Vorlage „Neues Schuljahr“: Schritte mit Stand; ohne Vorjahr kein Hochstufen, nur der Hinweis auf den leeren Entwurf
  const card = page.getByTestId("vorlage-neues-schuljahr");
  await expect(card.getByRole("heading", { name: "Neues Schuljahr" })).toBeVisible();
  const steps = card.getByRole("list", { name: "Schritte zum neuen Schuljahr" });
  await expect(steps.locator('[data-step="jahr"]')).toHaveAttribute("data-done", "ja");
  await expect(steps.locator('[data-step="wechsel"]')).toHaveAttribute("data-done", "nein");
  await expect(card).toContainText("gibt es kein Schuljahr – einen leeren Entwurf anlegen");
  await expect(card.getByRole("button", { name: "Entwurf fürs Schuljahr anlegen" })).toHaveCount(0);

  // Schuljahresabschluss: Kurzstatistik (nur Zahlen) und – vor dem Ende – kein Archivieren
  const closing = page.getByRole("region", { name: /^Schuljahresabschluss / });
  await expect(closing.getByTestId("kurzstatistik")).toContainText("Stunden laut Plan");
  await expect(closing.getByTestId("kurzstatistik")).toContainText("Entfall");
  await expect(closing.getByTestId("schuljahr-archiv")).toContainText("Archivieren geht nach dem Schuljahresende");
  await expect(closing.getByRole("button", { name: /archivieren/ })).toHaveCount(0);
  await expect(closing.getByRole("link", { name: "Vertretungsstatistik je Lehrkraft und Klasse" })).toBeVisible();
  await axe(page, "Versionsliste mit Schuljahresabschluss");
  await page.screenshot({ path: ".data/shots/e2e/planung-schuljahr.png", fullPage: true });

  // 360 px, dunkel
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", isMobile: false, storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const pErrors = collectErrors(p);
  await p.goto("/planung/versionen");
  await expect(p.getByTestId("vorlage-neues-schuljahr")).toBeVisible();
  await expect(p.getByTestId("kurzstatistik")).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axe(p, "Versionsliste 360 px dunkel");
  expect(pErrors).toEqual([]);
  await narrow.close();

  // Prüfung (Schulleitung): Kurzstatistik ohne Namen, keine Vorlagen und kein Archivieren
  await logoutForSwitch(page);
  await login(page, "petra.lindner");
  await page.goto("/planung/versionen");
  const seen = page.getByRole("region", { name: /^Schuljahresabschluss / });
  await expect(seen.getByTestId("kurzstatistik")).toContainText("Vertretung");
  await expect(seen).not.toContainText(/Brandt|Schulte|Lindner|Kowalski|Klasse \d/);
  await expect(page.getByTestId("vorlage-neues-schuljahr")).toHaveCount(0);
  await expect(page.getByTestId("schuljahr-archiv")).toHaveCount(0);
  expect(errors).toEqual([]);
});
