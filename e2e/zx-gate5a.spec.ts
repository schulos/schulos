import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { totpCode } from "@schulos/server/totp-code";
import { collectErrors, confirmNotenbuchNotice, DEMO_PASSWORD, login, logoutForSwitch } from "./helpers";

// P5-18: E2E Gate 5a – der Notenbuch-Ablauf Ende zu Ende. Katrin Schmitz (Biologie 7b) richtet die Zwei-Faktor-Anmeldung ein
// (die Demo-Instanz verlangt sie nicht, Q-5A-4 – die Pflicht selbst prüft service.test.ts), meldet sich mit Code an, bestätigt den
// Datenschutzhinweis, legt Buch und Spalten an, trägt per Tastatur ein, übernimmt die Vorschläge und schließt ab. Danach:
// Klassenleitung (nur Halbjahreswerte), fremde Lehrkraft/Admin (404, kein Override), Sekretariat mit ausdrücklich vergebenem
// Export-Recht (CSV), Schüler-/Elternsicht nur nach Einstellung, Entsperren durch die Schulleitung (Protokoll), verwaistes Buch →
// Hinweis in der Verwaltung → Übertragen, 15-Minuten-Sperre mit neuer Anmeldung.
// „zx-“: läuft nach notenbuch/offline-notenbuch (die erwarten den Datenschutzhinweis von jana.brandt beim ersten Öffnen) und vor
// zz-gate4c (Schuljahreswechsel – danach wären alle Bücher Vorjahr). Jeder Test räumt seine Einstellungen wieder auf.

test.describe.configure({ mode: "serial" });

const BI = "Klasse 7b – Biologie";
const GE = "Klasse 7b – Geschichte";

let katrinCtx: BrowserContext;
let katrin: Page;
let katrinErrors: string[] = [];
let bookPath = "";
let geschichtePath = "";
let firstStudent = "";
let students = 0;
const usedCodes = new Set<string>();
let secret = "";

const cell = (p: Page, student: string, column: string) => p.getByRole("textbox", { name: `${student} – ${column}`, exact: true });
const abschluss = (p: Page) => p.getByRole("article").filter({ has: p.getByRole("heading", { name: "Halbjahresabschluss" }) });

/** Nächster Code aus einem neuen 30-s-Fenster (ein Code gilt nur einmal). */
async function freshCode(): Promise<string> {
  for (;;) {
    const c = totpCode(secret);
    if (!usedCodes.has(c)) {
      usedCodes.add(c);
      return c;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function asUser(browser: Browser, username: string): Promise<Page> {
  const p = await (await browser.newContext()).newPage();
  await login(p, username);
  return p;
}

async function setNotenbuchSetting(browser: Browser, label: string, value: string) {
  const admin = await asUser(browser, "admin");
  await admin.goto("/verwaltung/rechte");
  const region = () => admin.getByRole("region", { name: "Einstellungen Notenbuch" });
  await region().getByLabel(label).selectOption(value);
  await expect(region().getByLabel(label)).toHaveValue(value);
  await admin.reload();
  await expect(region().getByLabel(label)).toHaveValue(value);
  await admin.context().close();
}

async function readCsv(download: import("@playwright/test").Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test.beforeAll(async ({ browser }) => {
  katrinCtx = await browser.newContext();
  katrin = await katrinCtx.newPage();
  katrinErrors = collectErrors(katrin);
});

test.afterAll(async () => {
  await katrinCtx.close();
});

test("Gate 5a: Lehrkraft mit 2FA – Hinweis, Buch, Spalten, Tastatureingabe, Vorschlag, Abschluss", async () => {
  test.setTimeout(150_000);
  const page = katrin;
  // 1. Zwei-Faktor-Anmeldung einrichten (Weg aus dem Notenbuch: /zwei-faktor?grund=notenbuch)
  await login(page, "katrin.schmitz");
  await page.goto("/zwei-faktor?grund=notenbuch");
  await expect(page.getByRole("note").filter({ hasText: "öffnet sich nur mit Zwei-Faktor-Anmeldung" })).toBeVisible();
  const start = page.getByRole("form", { name: "Einrichtung starten" });
  await start.getByLabel("Passwort zur Bestätigung").fill(DEMO_PASSWORD);
  await start.getByRole("button", { name: "Einrichtung starten" }).click();
  secret = (await page.getByLabel("Geheimnis").textContent())!.replace(/\s/g, "");
  const confirm = page.getByRole("form", { name: "Code bestätigen" });
  await confirm.getByLabel("2. Code aus der App").fill(await freshCode());
  await confirm.getByRole("button", { name: "Bestätigen und einschalten" }).click();
  await expect(page.getByRole("status")).toContainText("ist eingerichtet");
  // GATE-5a: der Weg zurück ins Notenbuch bleibt nach der Einrichtung erhalten
  await expect(page).toHaveURL("/zwei-faktor?eingerichtet=1&grund=notenbuch");
  // GATE-5a (G5A-S04): die Sitzung aus der Einrichtung ist nicht „mit Code angemeldet“ – das Notenbuch verlangt eine neue Anmeldung
  await page.getByRole("link", { name: "Weiter zum Notenbuch" }).click();
  await expect(page.getByRole("heading", { name: "Notenbuch: Anmeldung mit Code nötig" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Datenschutzhinweis zum Notenbuch" })).toHaveCount(0);

  // 2. Anmeldung mit zweitem Faktor
  await page.getByRole("button", { name: "Neu anmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Benutzername").fill("katrin.schmitz");
  await page.getByLabel("Passwort").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/login\/zweiter-faktor/);
  await page.getByLabel("Code aus der Authenticator-App").fill(await freshCode());
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page).toHaveURL(/\/notenbuch$/);

  // 3. Datenschutzhinweis beim ersten Öffnen; Seiten ohne Zwischenspeicher
  const res = await page.goto("/notenbuch");
  expect(res!.headers()["cache-control"]).toContain("no-store");
  const notice = page.getByRole("form", {
    name: "Datenschutzhinweis zum Notenbuch",
  });
  await expect(notice).toBeVisible();
  await notice.getByLabel("Ich habe den Hinweis gelesen und halte mich daran.").check();
  await notice.getByRole("button", { name: "Bestätigen und weiter" }).click();
  await expect(page.getByRole("heading", { name: "Meine Notenbücher" })).toBeVisible();

  // 4. Buch anlegen (nur eigene Lehraufträge stehen zur Wahl)
  const form = page.getByRole("form", { name: "Neues Notenbuch" });
  await expect(form.getByLabel("Lerngruppe und Fach").getByRole("option", { name: "Klasse 7b – Deutsch" })).toHaveCount(0);
  await form.getByLabel("Lerngruppe und Fach").selectOption({ label: BI });
  await form.getByLabel("Halbjahr").selectOption("1");
  await form.getByLabel("Skala").selectOption("noten6");
  await form.getByRole("button", { name: "Anlegen" }).click();
  await expect(form.getByRole("status")).toContainText("Notenbuch angelegt");
  await page.getByRole("link", { name: BI }).first().click();
  await expect(page.getByRole("heading", { name: BI })).toBeVisible();
  bookPath = new URL(page.url()).pathname;
  expect((await page.goto(bookPath))!.headers()["cache-control"]).toContain("no-store");

  // 5. Spalten: sonstige Leistung (Noten) und ein Test (Punkte, Vorgabe-Schlüssel)
  const neu = page.getByRole("form", { name: "Neue Spalte" });
  await neu.getByLabel("Titel").fill("Mikroskopieren");
  await neu.getByLabel("Art").selectOption("sonstige");
  await neu.getByRole("button", { name: "Spalte anlegen" }).click();
  await expect(page.getByRole("columnheader", { name: /Mikroskopieren/ })).toBeVisible();
  await neu.getByLabel("Titel").fill("Zelltest");
  await neu.getByLabel("Art").selectOption("schriftlich");
  await neu.getByLabel("Höchstpunktzahl").fill("20");
  await neu.getByRole("button", { name: "Spalte anlegen" }).click();
  await expect(page.getByRole("columnheader", { name: /Zelltest/ })).toBeVisible();

  // 6. Tastatur: alle bekommen eine 2 (Enter geht eine Zeile tiefer), die erste Person zusätzlich 18/20 Punkte (90 % → 1)
  const rows = page.getByRole("textbox", { name: / – Mikroskopieren$/ });
  students = await rows.count();
  expect(students).toBeGreaterThan(5);
  firstStudent = (await page.getByRole("table", { name: "Notentabelle" }).getByRole("rowheader").first().textContent())!.trim();
  await cell(page, firstStudent, "Mikroskopieren").click();
  for (let i = 0; i < students; i++) {
    await page.keyboard.type("2");
    await page.keyboard.press("Enter");
  }
  await cell(page, firstStudent, "Zelltest").click();
  await page.keyboard.type("18");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("noten-status")).not.toContainText("Speichert");
  // Kommentar (F2) – Schüler:innen und Eltern sehen ihn nie
  await cell(page, firstStudent, "Mikroskopieren").focus();
  await page.keyboard.press("F2");
  const kommentar = page.getByRole("form", { name: "Kommentar zur Note" });
  await kommentar.getByRole("textbox").fill("Sorgfältig gezeichnet");
  await kommentar.getByRole("button", { name: "Kommentar speichern" }).click();
  await expect(page.getByTestId("noten-status")).not.toContainText("Speichert");

  // 7. Live-Vorschlag: (1 + 2) / 2 = 1,5 → 1 (zugunsten der Schüler:in); alle anderen 2
  const firstRow = page.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: firstStudent, exact: true }),
  });
  await expect(firstRow.locator("[data-testid^=vorschlag-]")).toHaveText("1");
  await expect(page.locator("[data-testid^=vorschlag-]").nth(1)).toHaveText("2");
  await expect(page.getByRole("cell", { name: "Notenspiegel Mikroskopieren" })).toContainText(`2:${students}`);

  // 8. Halbjahresabschluss: Vorschläge übernehmen → sperren
  await abschluss(page)
    .getByRole("button", {
      name: new RegExp(`Vorschläge übernehmen \\(${students} offen\\)`),
    })
    .click();
  await expect(abschluss(page).getByRole("status")).toContainText(`${students} Vorschläge übernommen`);
  await expect(cell(page, firstStudent, "Halbjahresnote")).toHaveValue("1");
  await abschluss(page).getByRole("button", { name: "Abschließen und sperren" }).click();
  await abschluss(page).getByRole("button", { name: "Endgültig abschließen" }).click();
  await expect(abschluss(page)).toContainText("Abgeschlossen am");
  await expect(cell(page, firstStudent, "Mikroskopieren")).toHaveAttribute("readonly", "");
  // die Fachlehrkraft ist nicht Klassenleitung: keine Übergabeliste der 7b
  expect((await page.goto("/notenbuch/klasse/g-7b"))!.status()).toBe(404);
  expect(katrinErrors.filter((e) => !/status of 404/.test(e))).toEqual([]);
});

test("Gate 5a: Klassenleitung sieht nur Halbjahreswerte ihrer Klasse (protokolliert), nie Teilnoten", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await confirmNotenbuchNotice(page);
  await page.getByRole("link", { name: "Klasse 7b", exact: true }).click();
  await expect(
    page.getByRole("note").filter({
      hasText: "Entwurf – amtlich ist die Schulverwaltungssoftware",
    }),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Halbjahreswerte Klasse 7b" });
  await expect(table.getByRole("columnheader", { name: /^BI/ })).toBeVisible();
  await expect(page.locator("main")).toContainText("Biologie");
  await expect(page.locator("main")).not.toContainText("Mikroskopieren");
  await expect(page.locator("main")).not.toContainText("Sorgfältig");
  // die Notentabelle der Fachkollegin bleibt verborgen, ebenso eine fremde Klasse
  expect((await page.goto(bookPath))!.status()).toBe(404);
  expect((await page.goto("/notenbuch/klasse/g-7a"))!.status()).toBe(404);
  expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
});

test("Gate 5a: fremde Lehrkraft und Admin – 404, kein Admin-Override, kein Export", async ({ page }) => {
  for (const user of ["murat.yilmaz", "admin"]) {
    await login(page, user);
    await confirmNotenbuchNotice(page);
    expect((await page.goto(bookPath))!.status(), user).toBe(404);
    expect((await page.goto("/notenbuch/klasse/g-7b"))!.status(), user).toBe(404);
    const csv = await page.request.post("/api/notenbuch/export", {
      form: { groupId: "g-7b", schoolYearId: "", term: "1", encoding: "utf8" },
    });
    expect(csv.status(), user).toBe(404);
    await logoutForSwitch(page);
  }
});

test("Gate 5a: Sekretariat mit ausdrücklichem Export-Recht – CSV der Halbjahreswerte, keine Übergabeliste, keine Teilnoten", async ({ page, browser }) => {
  const errors = collectErrors(page);
  const EXPORT_FOR_VERWALTUNG = /^Halbjahreswerte für die Schulverwaltungssoftware exportieren.* für Verwaltung$/;
  const admin = await asUser(browser, "admin");
  await admin.goto("/verwaltung/rechte");
  await admin.getByRole("checkbox", { name: EXPORT_FOR_VERWALTUNG }).check();
  await admin.reload();
  await expect(admin.getByRole("checkbox", { name: EXPORT_FOR_VERWALTUNG })).toBeChecked();

  await login(page, "sabine.kowalski");
  await page.getByRole("link", { name: "Notenbuch", exact: true }).first().click();
  await confirmNotenbuchNotice(page);
  await expect(page.getByRole("form", { name: "Neues Notenbuch" })).toHaveCount(0);
  const form = page.getByRole("form", { name: "Halbjahreswerte exportieren" });
  await form.getByLabel("Klasse").selectOption({ label: "Klasse 7b" });
  await form.getByLabel("Halbjahr").selectOption("1");
  const [download] = await Promise.all([page.waitForEvent("download"), form.getByRole("button", { name: "CSV herunterladen" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^halbjahreswerte-klasse-7b-\d{4}-\d{2}-hj1\.csv$/);
  const csv = await readCsv(download);
  expect(csv).toContain(";Biologie;BI;Klasse 7b;");
  expect(csv).toMatch(/;BI;Klasse 7b;[^;]+;1;1;festgelegt/);
  expect(csv).not.toContain("Mikroskopieren");
  expect(csv).not.toContain("Sorgfältig");
  // keine Übergabeliste und keine Notentabelle – nur der Export
  expect((await page.goto("/notenbuch/klasse/g-7b"))!.status()).toBe(404);
  expect((await page.goto(bookPath))!.status()).toBe(404);

  // Recht wieder entziehen → kein Notenbuch mehr
  await admin.getByRole("checkbox", { name: EXPORT_FOR_VERWALTUNG }).uncheck();
  await admin.reload();
  await expect(admin.getByRole("checkbox", { name: EXPORT_FOR_VERWALTUNG })).not.toBeChecked();
  await admin.context().close();
  expect((await page.goto("/notenbuch"))!.status()).toBe(404);
  expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
});

test("Gate 5a: Schüler-/Elternsicht nur bei eingeschalteter Einstellung – eigene Noten ohne Kommentar", async ({ browser }) => {
  test.setTimeout(90_000);
  const lea = await asUser(browser, "lea.schaefer");
  const mother = await asUser(browser, "daniela.schaefer");
  const errorsOf = [collectErrors(lea), collectErrors(mother)];
  // Vorgabe aus
  expect((await lea.goto("/notenbuch"))!.status()).toBe(404);
  expect((await mother.goto("/notenbuch"))!.status()).toBe(404);

  await setNotenbuchSetting(browser, "Noten für Schüler:innen sichtbar", "teilnoten");
  await setNotenbuchSetting(browser, "Noten für Eltern sichtbar", "7");
  for (const p of [lea, mother]) {
    await p.goto("/");
    await p.getByRole("link", { name: "Noten", exact: true }).first().click();
    await expect(p.getByRole("heading", { name: "Noten", exact: true })).toBeVisible();
    const bio = p.getByRole("article", {
      name: /^Biologie \d{4}\/\d{2} 1\. Halbjahr/,
    });
    await expect(bio).toContainText("Halbjahresnote");
    await expect(bio.getByRole("table")).toContainText("Mikroskopieren");
    await expect(p.locator("main")).not.toContainText("Sorgfältig");
    // keine Lehrkräfte-Seiten
    expect((await p.goto(bookPath))!.status()).toBe(404);
    expect((await p.goto("/notenbuch/klasse/g-7b"))!.status()).toBe(404);
  }

  // zurück auf die Vorgabe (gemeinsame E2E-Datenbank)
  await setNotenbuchSetting(browser, "Noten für Eltern sichtbar", "0");
  await setNotenbuchSetting(browser, "Noten für Schüler:innen sichtbar", "aus");
  expect((await lea.goto("/notenbuch"))!.status()).toBe(404);
  expect((await mother.goto("/notenbuch"))!.status()).toBe(404);
  for (const e of errorsOf) expect(e.filter((m) => !/status of 404/.test(m))).toEqual([]);
  for (const p of [lea, mother]) await p.context().close();
});

test("Gate 5a: Schulleitung entsperrt mit Begründung (Recht notenbuch.unlock) – im Protokoll, Lehrkraft kann wieder ändern", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "petra.lindner");
  await confirmNotenbuchNotice(page);
  const unlock = page.getByRole("form", { name: `${BI} entsperren` });
  await unlock.getByLabel("Begründung").fill("Nachtrag Zelltest nach Krankheit");
  await unlock.getByRole("button", { name: "Entsperren" }).click();
  await expect(unlock).toHaveCount(0); // aus der Liste der abgeschlossenen Bücher verschwunden
  // die Schulleitung sieht dabei keine Noten
  expect((await page.goto(bookPath))!.status()).toBe(404);
  // Protokoll: Entsperren mit Begründung, Lesen der Übergabeliste durch die Klassenleitung
  await page.goto("/verwaltung/protokoll?bereich=notenbuch.");
  const entsperrt = page.getByRole("row").filter({ hasText: "Notenbuch entsperrt" }).first();
  await expect(entsperrt).toContainText("Petra Lindner");
  await expect(page.getByRole("row").filter({ hasText: "Notenbuch abgeschlossen und gesperrt" }).first()).toContainText("Katrin Schmitz");
  await page.goto("/verwaltung/protokoll?bereich=lesen.");
  await expect(page.getByRole("row").filter({ hasText: "Halbjahreswerte (Notenbuch) eingesehen" }).filter({ hasText: "Jana Brandt" }).first()).toBeVisible();
  expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);

  // die Fachlehrkraft (weiter mit 2FA-Sitzung) kann wieder eintragen
  await katrin.goto(bookPath);
  await expect(cell(katrin, firstStudent, "Mikroskopieren")).not.toHaveAttribute("readonly", "");
  await expect(abschluss(katrin)).not.toContainText("Abgeschlossen am");
});

test("Gate 5a: Abgang der Lehrkraft → Hinweis in der Verwaltung → Übertragen (ohne Noteneinsicht)", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  // Stefan Krause (Geschichte 7b) legt ein Buch an
  const stefan = await asUser(browser, "stefan.krause");
  await confirmNotenbuchNotice(stefan);
  const form = stefan.getByRole("form", { name: "Neues Notenbuch" });
  await form.getByLabel("Lerngruppe und Fach").selectOption({ label: GE });
  await form.getByLabel("Halbjahr").selectOption("1");
  await form.getByRole("button", { name: "Anlegen" }).click();
  await expect(form.getByRole("status")).toContainText("Notenbuch angelegt");
  await stefan.getByRole("link", { name: GE }).first().click();
  await expect(stefan.getByRole("heading", { name: GE })).toBeVisible();
  geschichtePath = new URL(stefan.url()).pathname;
  await stefan.context().close();

  // Admin trägt den Abgang ein → das Buch ist verwaist
  await login(page, "admin");
  await page.goto("/verwaltung/benutzer/u-stefan.krause");
  await page.getByRole("button", { name: "Abgang eintragen" }).click();
  await page.getByRole("form", { name: "Abgang eintragen" }).getByRole("button", { name: "Abgang speichern" }).click();
  await expect(page.getByText(/^Abgang am .* gesperrt\./)).toBeVisible();
  await logoutForSwitch(page);

  // Sekretariat (Benutzerverwaltung) sieht den Hinweis – ohne Weg zum Übertragen
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung");
  const card = page.getByRole("article", { name: "Verwaiste Notenbücher" });
  await expect(card).toContainText(`${GE} ·`);
  await expect(card).toContainText("1. Halbjahr");
  await expect(card.getByRole("link", { name: "Notenbücher übertragen" })).toHaveCount(0);
  await expect(card).not.toContainText("Stefan");
  await logoutForSwitch(page);

  // Admin (Recht „Übertragen“ als Vorgabe) überträgt an Jana Brandt und trägt Stefan Krause aus
  await login(page, "admin");
  await confirmNotenbuchNotice(page);
  await page.goto("/verwaltung");
  await card.getByRole("link", { name: "Notenbücher übertragen" }).click();
  await expect(page).toHaveURL(/\/notenbuch#uebertragen$/);
  const item = page.getByRole("listitem").filter({ hasText: GE }).filter({ hasText: "ohne aktive Lehrkraft" });
  await expect(item).toBeVisible();
  const transfer = page.getByRole("form", {
    name: `${GE} (1. Halbjahr) übertragen`,
  });
  await transfer.getByLabel("An Lehrkraft").selectOption({ label: "Jana Brandt" });
  await transfer.getByLabel("Austragen (optional)").selectOption({ label: "Stefan Krause" });
  await transfer.getByRole("button", { name: "Übertragen" }).click();
  await expect(transfer.getByRole("status")).toHaveText("Übertragen.");
  // ohne Noteneinsicht; der Hinweis ist weg
  expect((await page.goto(geschichtePath))!.status()).toBe(404);
  await page.goto("/verwaltung");
  await expect(page.getByText(`${GE} ·`)).toHaveCount(0);
  await page.goto("/verwaltung/protokoll?bereich=notenbuch.");
  await expect(page.getByRole("row").filter({ hasText: "Notenbuch übertragen" }).first()).toContainText("Admin");
  // Abgang zurücknehmen (gemeinsame E2E-Datenbank) – das Buch bleibt bei Jana Brandt
  await page.goto("/verwaltung/benutzer/u-stefan.krause");
  await page.getByRole("button", { name: "Abgang zurücknehmen" }).click();
  await expect(page.getByText("Das Konto ist aktiv.")).toBeVisible();
  await logoutForSwitch(page);

  const back = await asUser(browser, "stefan.krause");
  expect((await back.goto(geschichtePath))!.status()).toBe(404);
  await back.context().close();
  await login(page, "jana.brandt");
  await confirmNotenbuchNotice(page);
  await page.getByRole("link", { name: GE }).first().click();
  await expect(page.getByRole("heading", { name: GE })).toBeVisible();
  expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
});

test("Gate 5a: nach 15 Minuten ohne Eingabe gesperrt – Seiten, Übergabeliste und Export; weiter nur mit neuer Anmeldung", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.clock.install();
  await login(page, "jana.brandt");
  await confirmNotenbuchNotice(page);
  const res = await page.goto(geschichtePath);
  expect(res!.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: GE })).toBeVisible();

  // 16 Minuten ohne Eingabe: die Seite blendet aus, meldet die Sperre und lädt neu
  await page.clock.fastForward("16:00");
  await expect(page.getByRole("heading", { name: "Notenbuch gesperrt", exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(GE);
  for (const path of ["/notenbuch", "/notenbuch/klasse/g-7b", geschichtePath]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Notenbuch gesperrt", exact: true }), path).toBeVisible();
  }
  const csv = await page.request.post("/api/notenbuch/export", {
    form: { groupId: "g-7b", schoolYearId: "", term: "1", encoding: "utf8" },
  });
  expect(csv.status()).toBe(403);
  // der Rest von SchulOS bleibt nutzbar
  expect((await page.goto("/kalender"))!.status()).toBe(200);

  // „Neu anmelden“ beendet die Sitzung; nach der Anmeldung geht es weiter
  await page.goto("/notenbuch");
  await page.getByRole("button", { name: "Neu anmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Benutzername").fill("jana.brandt");
  await page.getByLabel("Passwort").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/notenbuch$/);
  await expect(page.getByRole("heading", { name: "Meine Notenbücher" })).toBeVisible();
  expect(errors.filter((e) => !/status of 40[34]/.test(e))).toEqual([]);
  await ctx.close();
});

test("Gate 5a: Aufräumen – Admin setzt die Zwei-Faktor-Anmeldung der Lehrkraft zurück", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/verwaltung/benutzer/u-katrin.schmitz");
  const card = page.getByRole("article", { name: "Zwei-Faktor-Anmeldung" });
  await expect(card).toContainText("eingeschaltet");
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Zwei-Faktor zurücksetzen" }).click();
  await expect(card.getByRole("status")).toHaveText("Zurückgesetzt.");
  await logoutForSwitch(page);
  // ohne 2FA kommt sie in der Demo wieder nur mit Passwort hinein
  await login(page, "katrin.schmitz");
});
