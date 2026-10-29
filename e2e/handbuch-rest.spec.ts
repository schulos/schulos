import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// HB-05…HB-07: Anhang hochladen/herunterladen (Eltern sehen ihn, Schülerin nicht), Seitenverlauf wiederherstellen, „?“ auf einer
// Modulseite führt zur Starter-Seite. Unabhängig von Wochentag und Uhrzeit; legt eigene Daten an und räumt sie wieder ab.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

test("HB-05/06: Anhang und Seitenverlauf – Eltern laden herunter, Schülerin nicht; Wiederherstellen; 360 px dunkel", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");

  // Bereich und Seite für Eltern anlegen
  await page.goto("/hilfe/bereiche");
  const create = page.getByRole("form", { name: "Bereich anlegen" });
  await create.getByLabel("Neuer Bereich").fill("E2E Anhänge");
  await create.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByRole("form", { name: "Bereich E2E Anhänge" })).toBeVisible();
  await page.goto("/hilfe/neu");
  const form = page.getByRole("form", { name: "Handbuchseite" });
  await form.getByLabel("Bereich").selectOption({ label: "E2E Anhänge" });
  await form.getByLabel("Status").selectOption("veroeffentlicht");
  await form.getByLabel("Titel").fill("E2E Speiseplan");
  await form.getByLabel("Text", { exact: true }).fill("Erste Fassung des Speiseplans.");
  for (const r of ["Lehrkräfte", "Personal", "Beratung (Schulsozialarbeit)", "Verwaltung"]) await form.getByLabel(r, { exact: true }).uncheck();
  await form.getByLabel("Eltern", { exact: true }).check();
  await form.getByRole("button", { name: "Seite anlegen" }).click();
  await expect(page).toHaveURL(/\/hilfe\/e2e-speiseplan$/);

  // Anhang: falscher Typ wird abgelehnt, PDF geht
  const upload = page.getByRole("form", { name: "Anhang hochladen" });
  await expect(upload.getByRole("note")).toContainText("keine Dateien mit Namen oder Daten");
  await upload.getByLabel("Datei").setInputFiles({ name: "programm.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ\u0090\u0000") });
  await upload.getByRole("button", { name: "Anhängen" }).click();
  await expect(upload.getByText(/Dateityp nicht erlaubt/)).toBeVisible();
  await upload.getByLabel("Datei").setInputFiles({ name: "Speiseplan Woche 1.pdf", mimeType: "application/pdf", buffer: PDF });
  await upload.getByRole("button", { name: "Anhängen" }).click();
  await expect(upload.getByRole("status")).toHaveText("Anhang hochgeladen.");
  const section = page.getByRole("region", { name: "Anhänge" });
  const link = section.getByRole("link", { name: /Speiseplan Woche 1\.pdf/ });
  await expect(link).toBeVisible();
  await axeClean(page);

  // zwei weitere Fassungen → Verlauf
  for (const text of ["Zweite Fassung des Speiseplans.", "Dritte Fassung des Speiseplans."]) {
    await page.goto("/hilfe/e2e-speiseplan/bearbeiten");
    await page.getByRole("form", { name: "Handbuchseite" }).getByLabel("Text", { exact: true }).fill(text);
    await page.getByRole("form", { name: "Handbuchseite" }).getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText(text)).toBeVisible();
  }
  await page.getByRole("link", { name: "Verlauf" }).click();
  await expect(page).toHaveURL(/\/hilfe\/e2e-speiseplan\/verlauf$/);
  await expect(page.getByRole("heading", { level: 1, name: "Seitenverlauf" })).toBeVisible();
  const cards = page.getByRole("list").getByRole("listitem");
  await expect(cards).toHaveCount(2);
  await axeClean(page);

  // schmal und dunkel (Pflegende): Seite und Verlauf
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark", storageState: await page.context().storageState() });
  const n = await narrow.newPage();
  const narrowErrors = collectErrors(n);
  for (const url of ["/hilfe/e2e-speiseplan", "/hilfe/e2e-speiseplan/verlauf"]) {
    await n.goto(url);
    await expect(n.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await n.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await axeClean(n);
  }
  await n.screenshot({ path: ".data/shots/e2e/handbuch-verlauf-360-dunkel.png", fullPage: true });
  await narrow.close();
  expect(narrowErrors).toEqual([]);

  // Erste Fassung wiederherstellen
  await cards.filter({ hasText: "Text anzeigen" }).last().locator("summary").click();
  await expect(cards.last()).toContainText("Erste Fassung des Speiseplans.");
  page.once("dialog", (d) => void d.accept());
  await cards.last().getByRole("button", { name: "Wiederherstellen" }).click();
  await expect(page).toHaveURL(/\/hilfe\/e2e-speiseplan$/);
  await expect(page.getByText("Erste Fassung des Speiseplans.")).toBeVisible();
  await page.goto("/hilfe/e2e-speiseplan/verlauf");
  await expect(cards).toHaveCount(3); // die dritte Fassung ist selbst im Verlauf
  expect(errors).toEqual([]);

  // Elternteil: sieht Anhang, lädt ihn herunter; kein Verlauf, kein Löschen
  await logoutForSwitch(page);
  await login(page, "daniela.schaefer");
  await page.goto("/hilfe/e2e-speiseplan");
  const parentLink = page.getByRole("region", { name: "Anhänge" }).getByRole("link", { name: /Speiseplan Woche 1\.pdf/ });
  await expect(parentLink).toBeVisible();
  await expect(page.getByRole("form", { name: "Anhang hochladen" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Verlauf" })).toHaveCount(0);
  const href = (await parentLink.getAttribute("href"))!;
  const res = await page.request.get(href.replace("?inline=1", ""));
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
  expect((await page.request.get("/hilfe/e2e-speiseplan/verlauf")).status()).toBe(404);

  // Schülerin: weder Seite noch Anhang
  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  expect((await page.request.get(href)).status()).toBe(404);
  expect((await page.request.get("/hilfe/e2e-speiseplan")).status()).toBe(404);

  // aufräumen
  await logoutForSwitch(page);
  await login(page, "sabine.kowalski");
  await page.goto("/hilfe/e2e-speiseplan");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Löschen", exact: true }).last().click();
  await expect(page).toHaveURL(/\/hilfe$/);
  await page.goto("/hilfe/bereiche");
  await page.getByRole("button", { name: "E2E Anhänge löschen" }).click();
  await expect(page.getByRole("form", { name: "Bereich E2E Anhänge" })).toHaveCount(0);
});

test("HB-07: „?“ auf einer Modulseite führt zur passenden Starter-Seite; ohne Zuordnung ins Handbuch", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "daniela.schaefer");
  const help = page.getByRole("banner").getByRole("link", { name: "Handbuch", exact: true });
  await page.goto("/abwesenheiten");
  await help.click();
  await expect(page).toHaveURL(/\/hilfe\/krankmeldung$/);
  await expect(page.getByRole("heading", { level: 1, name: "Krankmeldung" })).toBeVisible();
  await expect(page.getByText("Abwesenheit melden", { exact: false }).first()).toBeVisible();
  await axeClean(page);
  // Eltern: Erste Schritte auf den Kommunikationsseiten, Kurswahl auf der Kurswahl
  await page.goto("/news");
  await help.click();
  await expect(page).toHaveURL(/\/hilfe\/erste-schritte-fuer-eltern$/);
  await page.goto("/kurswahl");
  await help.click();
  await expect(page).toHaveURL(/\/hilfe\/kurswahl$/);
  // Startseite: ins Handbuch selbst
  await page.goto("/");
  await help.click();
  await expect(page).toHaveURL(/\/hilfe$/);
  // die Starter-Seiten, die Eltern nicht gelten, sehen sie nicht
  await expect(page.getByRole("link", { name: "Erste Schritte für Lehrkräfte und Personal" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Erste Schritte für Eltern" })).toBeVisible();

  // Lehrkraft: „Krankmeldung“ ist nicht für sie → „?“ bleibt beim Handbuch
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto("/abwesenheiten");
  await help.click();
  await expect(page).toHaveURL(/\/hilfe$/);
  await page.goto("/stundenplan");
  await help.click();
  await expect(page).toHaveURL(/\/hilfe\/erste-schritte-fuer-lehrkraefte-und-personal$/);
  expect(errors).toEqual([]);
});
