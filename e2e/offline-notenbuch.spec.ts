import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { collectErrors, confirmNotenbuchNotice, DEMO_PASSWORD, login } from "./helpers";

// P5-20: Offline-Eingabe auf Dienstgeräten. Dateiname „offline-…“, damit der Lauf (localeCompare) nach notenbuch.spec.ts kommt (dessen
// P5-17-Test erwartet den Datenschutzhinweis für jana.brandt beim ersten Öffnen; hier wird er mitbestätigt). Ohne Schul-CA im E2E-Server gibt es kein Gerätezertifikat – die Vorgabe
// („nur Geräte mit Gerätezertifikat“) lässt deshalb im Schulnetz keinen Zwischenspeicher zu. Nach der Einstellung „Schulnetz“
// schaltet die Lehrkraft die Offline-Eingabe je Gerät mit Bestätigung ein; der Browser-Kontext bleibt über die Tests erhalten
// (IndexedDB = das Gerät). Netz aus/an über `context.setOffline`. Von außen ohne Zertifikat (Kennzeichen wie von Caddy, siehe
// geraetezertifikate.spec.ts) gibt es auf dem Privatgerät nichts.

test.describe.configure({ mode: "serial" });

let ctx: BrowserContext;
let page: Page;
let errors: string[] = [];
let bookPath = "";
let s1 = "";
let s2 = "";
let s3 = "";

const cell = (p: Page, student: string, column: string) => p.getByRole("textbox", { name: `${student} – ${column}`, exact: true });
const panel = (p: Page) => p.getByRole("region", { name: "Offline-Eingabe" });
const status = (p: Page) => p.getByTestId("offline-status");
const SETTING = "Offline-Eingabe auf Dienstgeräten";

/** Konsolenfehler ohne die erwarteten Netzfehler während der Offline-Phasen. */
const realErrors = () => errors.filter((e) => !/fetch|network|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(e));

async function setOfflineMode(browser: Browser, value: "zertifikat" | "schulnetz") {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await admin.goto("/verwaltung/rechte");
  const region = () => admin.getByRole("region", { name: "Einstellungen Notenbuch" });
  await region().getByLabel(SETTING).selectOption(value);
  await expect(region().getByLabel(SETTING)).toHaveValue(value);
  await admin.reload();
  await expect(region().getByLabel(SETTING)).toHaveValue(value);
  await admin.context().close();
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  errors = collectErrors(page);
});

test.afterAll(async () => {
  await ctx.close();
});

test("P5-20: Vorgabe „Gerätezertifikat“ – im Schulnetz ohne Zertifikat kein Zwischenspeicher; „Schulnetz“ nur mit Bestätigung je Gerät", async ({
  browser,
}) => {
  await login(page, "jana.brandt");
  await confirmNotenbuchNotice(page);
  // eigenes Buch für diesen Test: Deutsch 7b im 2. Halbjahr (das 1. Halbjahr nutzt notenbuch.spec.ts)
  const form = page.getByRole("form", { name: "Neues Notenbuch" });
  await form.getByLabel("Lerngruppe und Fach").selectOption({ label: "Klasse 7b – Deutsch" });
  await form.getByLabel("Halbjahr").selectOption("2");
  await form.getByLabel("Skala").selectOption("noten6");
  await form.getByRole("button", { name: "Anlegen" }).click();
  await expect(form.getByRole("status")).toContainText("Notenbuch angelegt");
  await page.getByRole("listitem").filter({ hasText: "2. Halbjahr" }).getByRole("link", { name: "Klasse 7b – Deutsch" }).click();
  await expect(page.getByRole("heading", { name: "Klasse 7b – Deutsch" })).toBeVisible();
  bookPath = new URL(page.url()).pathname;
  const neu = page.getByRole("form", { name: "Neue Spalte" });
  await neu.getByLabel("Titel").fill("Vokabeltest");
  await neu.getByLabel("Art").selectOption("sonstige");
  await neu.getByRole("button", { name: "Spalte anlegen" }).click();
  await expect(page.getByRole("columnheader", { name: /Vokabeltest/ })).toBeVisible();
  const rows = page.getByRole("table", { name: "Notentabelle" }).getByRole("rowheader");
  s1 = (await rows.nth(0).textContent())!.trim();
  s2 = (await rows.nth(1).textContent())!.trim();
  s3 = (await rows.nth(2).textContent())!.trim();

  // Vorgabe: nur mit Gerätezertifikat – im Schulnetz nicht erkennbar, also nicht verfügbar
  await expect(status(page)).toHaveText("auf diesem Gerät nicht verfügbar");
  await expect(panel(page)).toContainText("nur auf Geräten mit Gerätezertifikat der Schule");
  await expect(panel(page).getByRole("button", { name: /einschalten/ })).toHaveCount(0);

  await setOfflineMode(browser, "schulnetz");
  await page.reload();
  await expect(status(page)).toHaveText("auf diesem Gerät nicht eingeschaltet");
  await expect(panel(page)).toContainText("verschlüsselten Zwischenspeicher");
  const on = panel(page).getByRole("button", { name: "Offline-Eingabe auf diesem Gerät einschalten" });
  await expect(on).toBeDisabled();
  await panel(page)
    .getByLabel(/Dienstgerät der Schule/)
    .check();
  await on.click();
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  await expect(status(page)).toContainText("verbunden");
  // bleibt über einen Neuaufbau der Seite eingeschaltet (Geräteanteil in IndexedDB, Server-Anteil aus der Sitzung)
  await page.reload();
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  expect(realErrors()).toEqual([]);
});

test("P5-20: ohne Verbindung eintragen → Warteschlange → wieder verbinden → übertragen", async () => {
  await page.goto(bookPath);
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  await ctx.setOffline(true);
  await expect(status(page)).toContainText("keine Verbindung");
  await cell(page, s1, "Vokabeltest").click();
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await expect(cell(page, s1, "Vokabeltest")).toHaveAttribute("data-offline", "pending");
  await expect(status(page)).toContainText("1 Änderung ausstehend");
  await expect(page.getByTestId("noten-status")).toContainText("offline gespeichert");
  // Halbjahresnoten gehen nur mit Verbindung
  await cell(page, s1, "Halbjahresnote").click();
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Verbindung prüfen" })).toBeVisible();
  await page.keyboard.press("Escape");

  await ctx.setOffline(false);
  await expect(status(page)).toContainText("verbunden");
  await expect(status(page)).not.toContainText("ausstehend");
  await expect(cell(page, s1, "Vokabeltest")).not.toHaveAttribute("data-offline", "pending");
  await page.goto(bookPath);
  await expect(cell(page, s1, "Vokabeltest")).toHaveValue("2");
  expect(realErrors()).toEqual([]);
});

test("P5-20: Konflikt – inzwischen online geändert: Server-Wert gegen lokale Eingabe, bewusste Auflösung je Zelle", async ({ browser }) => {
  await page.goto(bookPath);
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  await ctx.setOffline(true);
  await cell(page, s2, "Vokabeltest").click();
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await page.keyboard.type("5");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("2 Änderungen ausstehend");

  // dieselbe Lehrkraft an einem anderen Gerät trägt online andere Werte ein
  const other = await (await browser.newContext()).newPage();
  await login(other, "jana.brandt");
  await other.goto(bookPath);
  await cell(other, s2, "Vokabeltest").click();
  await other.keyboard.type("4");
  await other.keyboard.press("Enter");
  await other.keyboard.type("1");
  await other.keyboard.press("Enter");
  await expect(other.getByTestId("noten-status")).not.toContainText("Speichert");
  await other.goto(bookPath);
  await expect(cell(other, s2, "Vokabeltest")).toHaveValue("4");
  await expect(cell(other, s3, "Vokabeltest")).toHaveValue("1");

  await ctx.setOffline(false);
  const conflicts = page.getByRole("alert", { name: "Konflikte beim Abgleich" });
  await expect(conflicts).toContainText("2 Zellen wurden inzwischen auf dem Server geändert");
  const c2 = conflicts.getByRole("listitem").filter({ hasText: s2 });
  await expect(c2).toContainText("Server 4");
  await expect(c2).toContainText("deine Eingabe 3");
  // nichts still überschrieben: das andere Gerät sieht weiter 4 und 1
  await other.goto(bookPath);
  await expect(cell(other, s2, "Vokabeltest")).toHaveValue("4");
  await c2.getByRole("button", { name: "Meine Eingabe übernehmen" }).click();
  await expect(cell(page, s2, "Vokabeltest")).toHaveValue("3");
  const c3 = conflicts.getByRole("listitem").filter({ hasText: s3 });
  await expect(c3).toContainText("Server 1");
  await c3.getByRole("button", { name: "Server-Wert behalten" }).click();
  await expect(cell(page, s3, "Vokabeltest")).toHaveValue("1");
  await expect(conflicts).toHaveCount(0);
  await expect(status(page)).not.toContainText("ausstehend");
  await page.goto(bookPath);
  await expect(cell(page, s2, "Vokabeltest")).toHaveValue("3");
  await expect(cell(page, s3, "Vokabeltest")).toHaveValue("1");
  await other.context().close();
  expect(realErrors()).toEqual([]);
});

test("GATE-5a (G5A-C01): Offline-Eingaben überstehen die 15-Minuten-Sperre – nach der neuen Anmeldung übertragen", async () => {
  test.setTimeout(90_000);
  await page.goto(bookPath);
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  await ctx.setOffline(true);
  await cell(page, s3, "Vokabeltest").click();
  await page.keyboard.type("6");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("1 Änderung ausstehend");
  // Seite verlassen – die Warteschlange bleibt verschlüsselt im Browser –, länger als 15 Minuten nichts im Notenbuch
  await page.goto("about:blank");
  await ctx.setOffline(false);
  const lockPage = await ctx.newPage();
  const lockErrors = collectErrors(lockPage);
  await lockPage.clock.install();
  await lockPage.goto("/notenbuch");
  await expect(lockPage.getByRole("heading", { name: "Meine Notenbücher" })).toBeVisible();
  await lockPage.clock.fastForward("16:00");
  await expect(lockPage.getByRole("heading", { name: "Notenbuch gesperrt", exact: true })).toBeVisible();
  // „Neu anmelden“ beendet die Sitzung (Better Auth löscht sie) – der Server-Anteil des Geräts bleibt
  await lockPage.getByRole("button", { name: "Neu anmelden" }).click();
  await expect(lockPage).toHaveURL(/\/login/);
  await lockPage.getByLabel("Benutzername").fill("jana.brandt");
  await lockPage.getByLabel("Passwort").fill(DEMO_PASSWORD);
  await lockPage.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(lockPage).toHaveURL(/\/notenbuch$/);
  await lockPage.close();
  expect(lockErrors.filter((e) => !/status of 40[34]/.test(e))).toEqual([]);

  // das Gerät gilt weiter, die Warteschlange wird übertragen
  await page.goto(bookPath);
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  await expect(status(page)).not.toContainText("ausstehend");
  await page.goto(bookPath);
  await expect(cell(page, s3, "Vokabeltest")).toHaveValue("6");
  expect(realErrors()).toEqual([]);
});

test("GATE-5a (G5A-C01): Abmelden warnt, solange Offline-Eingaben nicht übertragen sind", async () => {
  await page.goto(bookPath);
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  await ctx.setOffline(true);
  await cell(page, s1, "Vokabeltest").click();
  await page.keyboard.type("5");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("1 Änderung ausstehend");
  await page.getByRole("button", { name: /Profilmenü öffnen/ }).click();
  // die Rückfrage abbrechen (der Klick wartet, bis der Dialog beantwortet ist – darum per Handler)
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.dismiss();
  });
  await page.getByRole("menuitem", { name: "Abmelden" }).click();
  await expect.poll(() => message).toContain("nicht übertragene Offline-Eingaben");
  await expect(page).toHaveURL(bookPath);
  // abgebrochen: weiter angemeldet, nach dem Verbinden übertragen
  await ctx.setOffline(false);
  await expect(status(page)).not.toContainText("ausstehend");
  await page.goto(bookPath);
  await expect(cell(page, s1, "Vokabeltest")).toHaveValue("5");
  expect(realErrors()).toEqual([]);
});

test("P5-20: von außen ohne Gerätezertifikat (Privatgerät) kein Zwischenspeicher; Ausschalten; Vorgabe zurück", async ({ browser }) => {
  const privat = await browser.newContext({ extraHTTPHeaders: { "x-schulos-extern": "alles" } });
  const p = await privat.newPage();
  await login(p, "jana.brandt");
  await p.goto(bookPath);
  await expect(status(p)).toHaveText("auf diesem Gerät nicht verfügbar");
  await expect(panel(p)).toContainText("auf Privatgeräten bleibt nichts im Browser");
  await expect(panel(p).getByRole("button", { name: /einschalten/ })).toHaveCount(0);
  await privat.close();

  await page.goto(bookPath);
  await expect(status(page)).toContainText("aktiv auf diesem Gerät");
  await panel(page).getByRole("button", { name: "Ausschalten" }).click();
  await expect(status(page)).toHaveText("auf diesem Gerät nicht eingeschaltet");
  await page.reload();
  await expect(status(page)).toHaveText("auf diesem Gerät nicht eingeschaltet");

  await setOfflineMode(browser, "zertifikat");
  await page.reload();
  await expect(status(page)).toHaveText("auf diesem Gerät nicht verfügbar");
  expect(realErrors()).toEqual([]);
});
