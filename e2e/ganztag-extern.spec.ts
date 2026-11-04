import AxeBuilder from "./axe";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, loginWithStartPassword, logoutForSwitch } from "./helpers";

// GT-13/GT-14: Verwaltung legt eine externe Leitung für die Schülerzeitung an (Vertraulichkeit Pflicht, Startdaten einmal sichtbar),
// verlängert und beendet den Zugang – 360 px dunkel, axe ohne Befund. Die Handbuchseite zum Ganztag ist für Eltern da. Lehrkräfte
// ohne „Ganztag verwalten“ kommen nicht auf die Seite. Das gesperrte Konto bleibt in der E2E-DB (Abgang, Löschung nach der Karenz).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const berlinDate = (offset: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86_400_000));

test("GT-13/14: externe Leitung anlegen, verlängern, beenden; Handbuch; 360 px dunkel", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/ganztag");
  await page.getByRole("link", { name: "Externe Leitungen" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Externe Leitungen" })).toBeVisible();

  const form = page.getByRole("form", { name: "Externe Leitung anlegen" });
  await form.getByLabel("Vorname").fill("Extern");
  await form.getByLabel("Nachname").fill("Zeitungsleitung");
  await form.getByLabel("Anbieter").fill("E2E Medienverein");
  await form.getByLabel("Angebot").selectOption({ label: "AG Schülerzeitung" });
  await form.getByLabel("Befristet bis").fill(berlinDate(30));
  await form.getByRole("checkbox", { name: /auf Vertraulichkeit verpflichtet/ }).check();
  await form.getByRole("button", { name: "Konto anlegen" }).click();
  const creds = page.getByRole("status", { name: "Startdaten" });
  await expect(creds).toContainText("Benutzername: extern.zeitungsleitung");
  await expect(creds).toContainText("Startpasswort:");
  const row = page.getByRole("list", { name: "Externe Leitungen" }).getByRole("listitem").filter({ hasText: "E2E Medienverein" });
  await expect(row).toContainText("AG Schülerzeitung");
  await expect(row).toContainText("aktiv");
  await expect(row).toContainText("2FA noch nicht eingerichtet");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(page);
  await page.screenshot({ path: ".data/shots/e2e/ganztag-extern-360-dunkel.png", fullPage: true });

  // verlängern
  const extend = row.getByRole("form", { name: "Befristung verlängern: Extern Zeitungsleitung" });
  await extend.getByLabel("Neues Ablaufdatum").fill(berlinDate(60));
  await extend.getByRole("button", { name: "Verlängern" }).click();
  await expect(row.getByRole("status").filter({ hasText: "Befristung gespeichert." })).toBeVisible();
  await page.reload();
  const [y, m, d] = berlinDate(60).split("-");
  await expect(row).toContainText(`befristet bis ${d}.${m}.${y}`);

  // beenden
  page.once("dialog", (dlg) => void dlg.accept());
  await row.getByRole("button", { name: "Zugang beenden" }).click();
  await expect(row.getByRole("status").filter({ hasText: "Zugang beendet" })).toBeVisible();
  await page.reload();
  await expect(row).toContainText("abgelaufen");
  await expect(row.getByRole("button", { name: "Wieder freigeben" })).toBeVisible();
  expect(errors).toEqual([]);
  await logoutForSwitch(page);
  await ctx.close();
});

test("GT-14: Lehrkraft ohne Recht sieht die Seite nicht; Eltern finden die Handbuchseite", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  expect((await page.goto("/ganztag/extern"))?.status()).toBe(404);
  expect((await page.goto("/ganztag/essen"))?.status()).toBe(404);
  errors.length = 0; // die 404 sind gewollt
  await logoutForSwitch(page);
  await login(page, "daniela.schaefer");
  await page.goto("/hilfe/ganztag-heimweg-mittagessen-und-externe-leitungen");
  await expect(page.getByRole("heading", { level: 1, name: "Ganztag: Heimweg, Mittagessen und externe Leitungen" })).toBeVisible();
  await expect(page.getByText(/Allergien und Unverträglichkeiten/).first()).toBeVisible();
  await axeClean(page);
  expect(errors).toEqual([]);
});

// GT-15 (Projektleitung 04.11.2026): Die externe Leitung sieht nur den Ganztag – ihr Angebot und die Anwesenheitsliste. Adressbuch,
// Messenger, Raumfinder und API-Routen anderer Module sind serverseitig zu (404/403), nicht nur aus der Navigation verschwunden.
// Die E2E-DB ist eine Demo-Instanz: 2FA ist dort freiwillig, das Startpasswort wird beim ersten Anmelden ersetzt.
test("GT-15/16: externe Leitung sieht nur den Ganztag; Adressbuch und Messenger gesperrt und ohne sie", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await browser.newContext();
  const office = await admin.newPage();
  await login(office, "sabine.kowalski");
  await office.goto("/ganztag/extern");
  const form = office.getByRole("form", { name: "Externe Leitung anlegen" });
  await form.getByLabel("Vorname").fill("Extern");
  await form.getByLabel("Nachname").fill("Rechtetest");
  await form.getByLabel("Anbieter").fill("E2E Rechteverein");
  await form.getByLabel("Angebot").selectOption({ label: "AG Schülerzeitung" });
  await form.getByLabel("Befristet bis").fill(berlinDate(30));
  await form.getByRole("checkbox", { name: /auf Vertraulichkeit verpflichtet/ }).check();
  await form.getByRole("button", { name: "Konto anlegen" }).click();
  const creds = office.getByRole("status", { name: "Startdaten" });
  await expect(creds).toContainText("Benutzername: extern.rechtetest");
  const password = (await creds.locator(".font-mono").nth(1).innerText()).trim();
  // GT-16: für Beschäftigte steht die externe Leitung weder im Adressbuch noch in der Messenger-Empfängerwahl – im Ganztag schon
  await office.goto("/adressbuch?q=Rechtetest");
  await expect(office.getByText("Nichts gefunden für „Rechtetest“")).toBeVisible();
  await office.goto("/messenger");
  await office.getByRole("button", { name: "Neuer Chat" }).click();
  await office.getByLabel("Person suchen").fill("Rechtetest");
  await expect(office.getByText("Niemand gefunden.")).toBeVisible();
  await office.keyboard.press("Escape");
  await office.goto("/ganztag/extern");
  await expect(office.getByRole("list", { name: "Externe Leitungen" }).getByRole("listitem").filter({ hasText: "E2E Rechteverein" })).toContainText("AG Schülerzeitung");
  await admin.close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await loginWithStartPassword(page, "extern.rechtetest", password);
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("link", { name: "Ganztag" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Adressbuch" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Messenger" })).toHaveCount(0);
  await page.goto("/ganztag");
  await expect(page.getByText("AG Schülerzeitung").first()).toBeVisible();
  for (const path of ["/adressbuch", "/messenger", "/raeume", "/news", "/hilfe"]) expect((await page.goto(path))?.status(), path).toBe(404);
  expect((await page.request.get("/api/dateien/unbekannt")).status()).toBe(403);
  errors.length = 0; // die 404 sind gewollt
  await page.goto("/konto/sitzungen");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});
