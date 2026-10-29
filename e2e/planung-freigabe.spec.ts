import AxeBuilder from "./axe";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP3-03: Prüfung & Freigabe – Planung (frank.schulte) gibt einen Entwurf zur Prüfung, die Schulleitung (petra.lindner) kommentiert, gibt
// zurück und gibt nach erneuter Einreichung frei; die Lehrkraft (jana.brandt) sieht „Mein Plan ab …“ nur bei eingeschalteter Vorschau und nur
// ihren eigenen Plan, schreibt der Planung einen Kommentar und sieht keine fremden Kommentare; die Schülerin bekommt 404. Prüfseite und
// Vorschau mit axe, schmal (360 px) und dunkel. Räumt auf (Entwurf verworfen).
const tag = Date.now().toString(36);
const NAME = `E2E Freigabe ${tag}`;
const SL_NOTE = `Bitte Di prüfen ${tag}`;
const BACK_NOTE = `Raumtausch fehlt ${tag}`;
const OWN_NOTE = `Mo früh passt nicht ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function as(browser: Browser, user: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { page, errors, close: () => ctx.close() };
}

test("SP3-03: zur Prüfung geben, kommentieren, zurückgeben, freigeben; Lehrkräfte-Vorschau nur eigener Plan", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // Planung: Entwurf aus dem gültigen Plan anlegen und zur Prüfung geben (Vorschau noch aus)
  await page.goto("/planung/versionen");
  const form = page.getByRole("form", { name: "Entwurf anlegen" });
  await form.getByLabel("Name").fill(NAME);
  await form.getByRole("button", { name: "Entwurf anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${NAME}“ angelegt` })).toBeVisible();
  const card = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME}$`) });
  await card.getByRole("link", { name: /^Prüfung & Kommentare/ }).click();
  await expect(page).toHaveURL(/\/planung\/versionen\/pruefung\?version=[\w-]+$/);
  const versionId = new URL(page.url()).searchParams.get("version")!;
  const reviewUrl = page.url();
  await expect(page.getByRole("heading", { name: /^Prüfung · Version \d+\.0$/, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
  await expect(page.getByRole("status")).toContainText("Zur Prüfung gegeben");
  await expect(page.getByText("in Prüfung", { exact: true })).toBeVisible();
  // in Prüfung nur lesbar: kein „Im Entwurf arbeiten“, kein zweites Einreichen
  await expect(page.getByRole("link", { name: "Im Entwurf arbeiten" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zur Prüfung geben" })).toHaveCount(0);

  // Lehrkraft: ohne eingeschaltete Vorschau gibt es nichts zu sehen
  const jana = await as(browser, "jana.brandt");
  expect((await jana.page.goto(`/stundenplan/vorschau?version=${versionId}`))?.status()).toBe(404);

  // Planung schaltet die Vorschau ein
  await page.getByRole("button", { name: "Vorschau einschalten" }).click();
  await expect(page.getByRole("status")).toContainText("Lehrkräfte-Vorschau eingeschaltet");
  await expect(page.getByRole("button", { name: "Vorschau ausschalten" })).toBeVisible();

  // Schulleitung: Übersicht → Versionen (nur ab „in Prüfung“) → Prüfen; Kommentar an die Lehrkraft; zurück an die Planung mit Begründung
  const sl = await as(browser, "petra.lindner");
  await sl.page.goto("/planung");
  await expect(sl.page.getByRole("region", { name: "Planprüfung" })).toContainText("Planentwürfe zur Prüfung");
  await sl.page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Versionen" }).click();
  await expect(sl.page.getByRole("form", { name: "Entwurf anlegen" })).toHaveCount(0);
  await expect(sl.page.locator('article[data-status="entwurf"]')).toHaveCount(0);
  const slCard = sl.page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME}$`) });
  await expect(slCard.getByRole("button")).toHaveCount(0);
  await slCard.getByRole("link", { name: /^Prüfen/ }).click();
  await expect(sl.page).toHaveURL(reviewUrl);
  await expect(sl.page.getByRole("button", { name: "Vorschau einschalten" })).toHaveCount(0);
  const comment = sl.page.getByRole("form", { name: "Kommentar schreiben" });
  await comment.getByRole("radio", { name: "Lehrkraft" }).check();
  await comment.getByRole("combobox", { name: "Lehrkraft" }).selectOption("u-jana.brandt");
  await comment.getByLabel("Kommentar").fill(SL_NOTE);
  await comment.getByRole("button", { name: "Kommentar speichern" }).click();
  await expect(sl.page.getByRole("status")).toContainText("Kommentar gespeichert");
  const slComment = sl.page.getByTestId("kommentar").filter({ hasText: SL_NOTE });
  await expect(slComment).toContainText(/Lehrkraft BRA/);
  // die Prüfung erledigt keine Kommentare (das macht die Planung)
  await expect(slComment.getByRole("button")).toHaveCount(0);
  await axe(sl.page, "Prüfseite (Schulleitung)");
  await sl.page.screenshot({ path: ".data/shots/e2e/planung-freigabe-pruefung.png", fullPage: true });

  // Lehrkraft: Hinweis im eigenen Stundenplan → Vorschau nur der eigenen Stunden; Kommentar an die Planung; fremde Kommentare unsichtbar
  await jana.page.goto("/stundenplan");
  await jana.page.getByRole("link", { name: /^Vorschau „Mein Plan ab / }).click();
  await expect(jana.page).toHaveURL(/\/stundenplan\/vorschau$/);
  await jana.page.goto(`/stundenplan/vorschau?version=${versionId}`);
  await expect(jana.page.getByTestId("vorschau-hinweis")).toContainText("Entwurf – kann sich noch ändern.");
  await expect(jana.page.getByTestId("vorschau-hinweis")).toContainText(NAME);
  const grid = jana.page.getByRole("table", { name: /^Mein Plan ab / });
  await expect(grid).toBeVisible();
  // nur eigene Stunden: keine Lehrkraft-Kürzel anderer, keine Prüfkommentare
  const gridText = await grid.innerText();
  expect(gridText).not.toMatch(/\b(LIN|KLE|SCU)\b/);
  await expect(jana.page.getByText(SL_NOTE)).toHaveCount(0);
  const own = jana.page.getByRole("form", { name: "Kommentar an die Stundenplanung" });
  await own.getByLabel("Bezug").selectOption({ index: 1 });
  await own.getByLabel("Kommentar").fill(OWN_NOTE);
  await own.getByRole("button", { name: "Kommentar senden" }).click();
  await expect(jana.page.getByRole("status")).toContainText("Danke");
  await expect(jana.page.getByTestId("eigener-kommentar")).toHaveCount(1);
  await expect(jana.page.getByTestId("eigener-kommentar")).toContainText(OWN_NOTE);
  await expect(jana.page.getByText(SL_NOTE)).toHaveCount(0);
  await axe(jana.page, "Vorschau (Lehrkraft)");
  await jana.page.screenshot({ path: ".data/shots/e2e/planung-freigabe-vorschau.png", fullPage: true });

  // Schülerin: weder Vorschau noch Prüfseite
  const lea = await as(browser, "lea.schaefer");
  expect((await lea.page.goto(`/stundenplan/vorschau?version=${versionId}`))?.status()).toBe(404);
  expect((await lea.page.goto(reviewUrl))?.status()).toBe(404);
  await lea.page.goto("/stundenplan");
  await expect(lea.page.getByRole("link", { name: /Mein Plan ab/ })).toHaveCount(0);
  await lea.close();

  // Schulleitung gibt zurück (mit Begründung) → wieder Entwurf; die Vorschau verschwindet für die Lehrkraft
  await sl.page.goto(reviewUrl);
  const back = sl.page.getByRole("form", { name: "Zurück an die Planung" });
  await back.getByLabel("Begründung (optional)").fill(BACK_NOTE);
  await back.getByRole("button", { name: "Zurück an die Planung" }).click();
  // die Prüfung sieht den Entwurf danach nicht mehr – zurück zur Versionsliste
  await expect(sl.page).toHaveURL(/\/planung\/versionen\?(jahr=[\w-]+&)?zurueck=1$/);
  await expect(sl.page.getByRole("status")).toContainText("zurück an die Planung");
  await expect(slCard).toHaveCount(0);
  expect((await sl.page.goto(reviewUrl))?.status()).toBe(404);
  expect((await jana.page.goto(`/stundenplan/vorschau?version=${versionId}`))?.status()).toBe(404);

  // Planung: sieht Begründung, Vorschau-Kommentar (erledigt ihn) und reicht erneut ein
  await page.goto(reviewUrl);
  await expect(page.getByText("Entwurf", { exact: true })).toBeVisible();
  await expect(page.getByTestId("kommentar").filter({ hasText: BACK_NOTE })).toContainText("ganze Version");
  const fromPreview = page.getByTestId("kommentar").filter({ hasText: OWN_NOTE });
  await expect(fromPreview).toContainText("aus der Lehrkräfte-Vorschau");
  await fromPreview.getByRole("button", { name: "Erledigt" }).click();
  await expect(page.getByTestId("kommentar").filter({ hasText: OWN_NOTE })).toHaveAttribute("data-erledigt", "ja");
  await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
  await expect(page.getByRole("status")).toContainText("Zur Prüfung gegeben");

  // Schulleitung gibt frei
  await sl.page.goto(reviewUrl);
  await sl.page.getByRole("button", { name: "Freigeben" }).click();
  await expect(sl.page.getByRole("status")).toContainText("Freigegeben");
  await expect(sl.page.getByTestId("freigabe")).toContainText("Petra Lindner");
  await expect(sl.page.getByTestId("freigabe")).not.toContainText("selbst freigegeben");
  await expect(sl.page.getByRole("button", { name: /Freigabe zurücknehmen/ })).toBeVisible();

  // Lehrkraft: Vorschau wieder da (freigegeben), ihr erledigter Kommentar mit Vermerk
  await jana.page.goto(`/stundenplan/vorschau?version=${versionId}`);
  await expect(jana.page.getByTestId("vorschau-hinweis")).toContainText("freigegeben, aber noch nicht veröffentlicht");
  await expect(jana.page.getByTestId("eigener-kommentar")).toContainText("erledigt");

  // schmal und dunkel: Prüfseite (Schulleitung) und Vorschau (Lehrkraft) ohne axe-Befund und ohne seitliches Scrollen
  for (const [who, url] of [
    [sl.page, reviewUrl],
    [jana.page, `/stundenplan/vorschau?version=${versionId}`],
  ] as const) {
    const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await who.context().storageState() });
    const p = await narrow.newPage();
    await p.goto(url);
    await expect(p.getByRole("main")).toBeVisible();
    await axe(p, `${url} (360 px, dunkel)`);
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await p.screenshot({ path: `.data/shots/e2e/planung-freigabe-${who === sl.page ? "pruefung" : "vorschau"}-mobil-dunkel.png`, fullPage: true });
    await narrow.close();
  }

  // aufräumen: Entwurf verwerfen (auch freigegeben ist er noch offen)
  await page.goto("/planung/versionen");
  await expect(card.getByRole("link", { name: /^Freigabe ansehen/ })).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Verwerfen" }).click();
  await expect(card.getByText("verworfen", { exact: true })).toBeVisible();

  // die absichtlichen 404 (Vorschau aus, Prüfung nach der Rückgabe) meldet der Browser selbst als Konsolenfehler
  expect([...errors, ...[...sl.errors, ...jana.errors].filter((e) => !/status of 404/.test(e))]).toEqual([]);
  await sl.close();
  await jana.close();
});
