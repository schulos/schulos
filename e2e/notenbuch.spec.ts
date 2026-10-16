import { expect, test, type Page } from "@playwright/test";
import { collectErrors, confirmNotenbuchNotice, login, logoutForSwitch } from "./helpers";

// P5-12/P5-13: Notenbuch – die Lehrkraft legt ein Buch an, trägt Noten nur per Tastatur ein (ungültige Eingabe abgelehnt,
// Kommentar mit Hinweis), Vorschlag und Notenspiegel rechnen live, Gewichte mit Hinweis ≠ 100 %; Seiten ohne Zwischenspeicher.
// Fremde Lehrkraft, Schulleitung und Admin sehen die Notentabelle nicht (404). Die Demo-Instanz verlangt keine 2FA (Q-5A-4).
// P5-17: Vor der ersten Nutzung kommt der Datenschutzhinweis – wer das Notenbuch öffnet, bestätigt ihn (`confirmNotenbuchNotice`).

test.describe.configure({ mode: "serial" });

let bookPath = "";
let firstStudent = "";
let secondStudent = "";

const cell = (page: Page, student: string, column: string) => page.getByRole("textbox", { name: `${student} – ${column}`, exact: true });

test("P5-17: Datenschutzhinweis beim ersten Öffnen – erst nach Bestätigung Zugriff, danach zum Nachlesen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  const res = await page.goto("/notenbuch");
  expect(res!.headers()["cache-control"]).toContain("no-store");
  const form = page.getByRole("form", { name: "Datenschutzhinweis zum Notenbuch" });
  await expect(form).toBeVisible();
  await expect(page.getByText("§ 2 Abs. 2 VO-DV I")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Meine Notenbücher" })).toHaveCount(0);
  // ohne Häkchen geht es nicht weiter (Pflichtfeld)
  await form.getByRole("button", { name: "Bestätigen und weiter" }).click();
  await expect(form).toBeVisible();
  await form.getByLabel("Ich habe den Hinweis gelesen und halte mich daran.").check();
  await form.getByRole("button", { name: "Bestätigen und weiter" }).click();
  await expect(page.getByRole("heading", { name: "Meine Notenbücher" })).toBeVisible();
  await page.reload();
  await expect(form).toHaveCount(0);
  // zum Nachlesen eingeklappt auf der Übersicht
  await page.getByText("Datenschutzhinweis zum Notenbuch").click();
  await expect(page.getByText("Kommentare kurz und sachlich", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test("P5-12: Notentabelle – anlegen, Spalten, Tastatureingabe, Kommentar, Live-Vorschlag, Notenspiegel, no-store", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  const list = await page.goto("/notenbuch");
  expect(list!.headers()["cache-control"]).toContain("no-store");
  const form = page.getByRole("form", { name: "Neues Notenbuch" });
  await form.getByLabel("Lerngruppe und Fach").selectOption({ label: "Klasse 7b – Deutsch" });
  await form.getByLabel("Halbjahr").selectOption("1");
  await form.getByLabel("Skala").selectOption("noten6");
  await form.getByRole("button", { name: "Anlegen" }).click();
  await expect(form.getByRole("status")).toContainText("Notenbuch angelegt");
  await page.getByRole("link", { name: "Klasse 7b – Deutsch" }).first().click();
  await expect(page.getByRole("heading", { name: "Klasse 7b – Deutsch" })).toBeVisible();
  bookPath = new URL(page.url()).pathname;

  // zwei Spalten: mündlich (Noten) und Klassenarbeit (Punkte, Vorgabe-Schlüssel)
  const neu = page.getByRole("form", { name: "Neue Spalte" });
  await neu.getByLabel("Titel").fill("Mündlich");
  await neu.getByLabel("Art").selectOption("sonstige");
  await neu.getByRole("button", { name: "Spalte anlegen" }).click();
  await expect(neu.getByRole("status")).toContainText("Spalte angelegt");
  await expect(page.getByRole("columnheader", { name: /Mündlich/ })).toBeVisible();
  await neu.getByLabel("Titel").fill("1. Klassenarbeit");
  await neu.getByLabel("Art").selectOption("schriftlich");
  await neu.getByLabel("Höchstpunktzahl").fill("40");
  await expect(neu.getByRole("group", { name: /Notenschlüssel/ })).toBeVisible();
  await neu.getByRole("button", { name: "Spalte anlegen" }).click();
  await expect(page.getByRole("columnheader", { name: /1\. Klassenarbeit/ })).toBeVisible();

  const rows = page.getByRole("table", { name: "Notentabelle" }).getByRole("rowheader");
  firstStudent = (await rows.nth(0).textContent())!.trim();
  secondStudent = (await rows.nth(1).textContent())!.trim();

  // Tastatur: 2 + Enter → nächste Zeile; ungültige 7 bleibt rot und wird nicht gespeichert; Escape verwirft; „f“ = fehlt
  await cell(page, firstStudent, "Mündlich").click();
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await expect(cell(page, secondStudent, "Mündlich")).toBeFocused();
  await page.keyboard.type("7");
  await page.keyboard.press("Enter");
  await expect(cell(page, secondStudent, "Mündlich")).toBeFocused();
  await expect(cell(page, secondStudent, "Mündlich")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "Gültig sind 1 bis 6" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cell(page, secondStudent, "Mündlich")).not.toHaveAttribute("aria-invalid", "true");
  await page.keyboard.type("f");
  await page.keyboard.press("Enter");
  // Pfeil nach oben, dann nach rechts in die Klassenarbeit: 34 von 40 Punkten (85 %) → 1
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(cell(page, firstStudent, "Mündlich")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(cell(page, firstStudent, "1. Klassenarbeit")).toBeFocused();
  await page.keyboard.type("34");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("noten-status")).not.toContainText("Speichert");
  // Live-Vorschlag: (2 + 1) / 2 = 1,5 → 1 (x,5 zugunsten der Schüler:in)
  const firstRow = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: firstStudent, exact: true }) });
  await expect(firstRow.locator("[data-testid^=vorschlag-]")).toHaveText("1"); // Vorschlag
  await expect(firstRow.getByRole("cell").last()).toHaveText(/^\d+$/); // Fehlstunden aus eigenen Stunden (Demo-Klassenbuch)
  await expect(firstRow).toContainText("1,50");
  // Notenspiegel ohne Namen
  await expect(page.getByRole("cell", { name: "Notenspiegel Mündlich" })).toContainText("2:1");
  await expect(page.getByRole("cell", { name: "Notenspiegel Mündlich" })).toContainText("fehlt 1");

  // Kommentar per F2 mit Hinweis auf Gesundheits-/Verhaltensangaben
  await cell(page, firstStudent, "Mündlich").focus();
  await page.keyboard.press("F2");
  const kommentar = page.getByRole("form", { name: "Kommentar zur Note" });
  await expect(kommentar).toContainText("keine Gesundheits- oder Verhaltensangaben");
  await expect(kommentar.getByRole("textbox")).toBeFocused();
  await page.keyboard.type("Gute Beiträge zur Gedichtanalyse");
  await kommentar.getByRole("button", { name: "Kommentar speichern" }).click();
  await expect(cell(page, firstStudent, "Mündlich")).toBeFocused();
  await expect(page.getByTestId("noten-status")).not.toContainText("Speichert");

  // Gewichte ≠ 100 % → Hinweis
  const gewichte = page.getByRole("form", { name: "Gewichtung" });
  await gewichte.getByLabel("Schriftliche Arbeiten (%)").fill("60");
  await gewichte.getByLabel("Sonstige Leistungen (%)").fill("30");
  await gewichte.getByRole("button", { name: "Gewichte speichern" }).click();
  await expect(page.getByRole("note").filter({ hasText: "90 % statt 100 %" })).toBeVisible();

  // neu laden: alles gespeichert, Seite ohne Zwischenspeicher
  const res = await page.goto(bookPath);
  expect(res!.headers()["cache-control"]).toContain("no-store");
  await expect(cell(page, firstStudent, "Mündlich")).toHaveValue("2");
  await expect(cell(page, secondStudent, "Mündlich")).toHaveValue("fehlt");
  await expect(cell(page, firstStudent, "1. Klassenarbeit")).toHaveValue("34");
  // Punkte-Spalte zeigt die Note aus dem Schlüssel daneben (85 % → 1)
  await expect(page.getByRole("cell").filter({ has: cell(page, firstStudent, "1. Klassenarbeit") })).toHaveText("1");
  await expect(page.getByLabel("mit Kommentar")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("P5-12: fremde Lehrkraft, Schulleitung und Admin sehen die Notentabelle nicht", async ({ page }) => {
  for (const user of ["murat.yilmaz", "petra.lindner", "admin"]) {
    await login(page, user);
    await confirmNotenbuchNotice(page);
    const res = await page.goto(bookPath);
    expect(res!.status(), user).toBe(404);
    await logoutForSwitch(page);
  }
});

test("P5-16: Startseite und Kursraum verlinken nur eigene Notenbücher, ohne Noten", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/");
  const widget = page.getByRole("article", { name: "Meine Notenbücher" });
  await expect(widget.getByRole("link", { name: /Klasse 7b – Deutsch/ })).toBeVisible();
  await expect(widget).not.toContainText("Mündlich");
  await page.goto("/kurse/g-7b");
  const card = page.getByRole("article", { name: "Notenbuch", exact: true });
  await card.getByRole("link", { name: /Deutsch · 1\. Halbjahr/ }).click();
  await expect(page).toHaveURL(new RegExp(`${bookPath}$`));
  expect(errors).toEqual([]);
  await logoutForSwitch(page);
  // andere Lehrkraft: kein Widget, kein Link im Kursraum
  await login(page, "murat.yilmaz");
  await page.goto("/");
  await expect(page.getByRole("article", { name: "Meine Notenbücher" })).toHaveCount(0);
  await page.goto("/kurse/g-7b");
  await expect(page.getByRole("heading", { name: "Notenbuch", exact: true })).toHaveCount(0);
});

test("P5-13: Halbjahresabschluss – Vorschläge übernehmen, abweichend festlegen, sperren", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto(bookPath);
  const abschluss = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Halbjahresabschluss" }) });
  await abschluss.getByRole("button", { name: /Vorschläge übernehmen/ }).click();
  await expect(abschluss.getByRole("status")).toContainText("1 Vorschlag übernommen");
  await expect(cell(page, firstStudent, "Halbjahresnote")).toHaveValue("1");
  // per Tastatur: zweite Person „befreit“ (b), alle weiteren 3 – Enter geht nach unten; ungültige 9 wird abgelehnt
  const count = await page.getByRole("table", { name: "Notentabelle" }).getByRole("rowheader").count();
  await cell(page, secondStudent, "Halbjahresnote").click();
  await page.keyboard.type("9");
  await page.keyboard.press("Enter");
  await expect(cell(page, secondStudent, "Halbjahresnote")).toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.type("b");
  await page.keyboard.press("Enter");
  for (let i = 2; i < count; i++) {
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("noten-status")).not.toContainText("Speichert");
  await expect(cell(page, secondStudent, "Halbjahresnote")).toHaveValue("befreit");
  await abschluss.getByRole("button", { name: "Abschließen und sperren" }).click();
  await abschluss.getByRole("button", { name: "Endgültig abschließen" }).click();
  await expect(abschluss).toContainText("Abgeschlossen am");
  await expect(cell(page, firstStudent, "Mündlich")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("note").filter({ hasText: "abgeschlossen und gesperrt" })).toBeVisible();
  // die Klassenleitung (hier dieselbe Lehrkraft) sieht die Übergabeliste ihrer Klasse
  await page.goto("/notenbuch");
  await expect(page.getByRole("link", { name: "Klasse 7b", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("P5-13: Schulleitung – Übergabeliste ohne Teilnoten, CSV-Export per POST, Entsperren mit Begründung", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "petra.lindner");
  await page.goto("/notenbuch");
  await page.getByRole("link", { name: "Klasse 7b", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Klasse 7b" })).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "Entwurf – amtlich ist die Schulverwaltungssoftware" })).toBeVisible();
  const table = page.getByRole("table", { name: "Halbjahreswerte Klasse 7b" });
  const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: firstStudent, exact: true }) });
  await expect(row).toContainText("1");
  await expect(page.locator("main")).not.toContainText("Mündlich");
  await expect(page.locator("main")).not.toContainText("Gedichtanalyse");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV herunterladen" }).click()]);
  expect(download.suggestedFilename()).toBe("halbjahreswerte-klasse-7b-2026-27-hj1.csv");
  const csv = await download.createReadStream().then(async (s) => {
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  });
  expect(csv).toContain("Klasse;Nachname;Vorname;Fach;Fachkürzel;Lerngruppe;Schuljahr;Halbjahr;Note;Status");
  expect(csv).toContain(";D;Klasse 7b;2026/27;1;befreit;festgelegt");
  expect(csv).not.toContain("Mündlich");
  // GET (Link, Bild, Vorabruf) exportiert nichts
  expect((await page.request.get("/api/notenbuch/export")).status()).toBe(405);

  await page.goto("/notenbuch");
  const unlock = page.getByRole("form", { name: "Klasse 7b – Deutsch entsperren" });
  await unlock.getByRole("button", { name: "Entsperren" }).click();
  await expect(unlock.getByText("Bitte kurz begründen")).toBeVisible();
  await unlock.getByLabel("Begründung").fill("Nachtrag nach Rücksprache");
  await unlock.getByRole("button", { name: "Entsperren" }).click();
  await expect(unlock).toHaveCount(0); // aus der Liste der abgeschlossenen Bücher verschwunden
  expect(errors).toEqual([]);
  // die Notentabelle bleibt der Schulleitung verborgen
  expect((await page.goto(bookPath))!.status()).toBe(404);
});

test("P5-14: Schüler-/Elternsicht – Vorgabe aus, nach Einstellung nur eigene Halbjahresnoten ohne Kommentare", async ({ browser }) => {
  const jana = await (await browser.newContext()).newPage();
  const lea = await (await browser.newContext()).newPage();
  const mother = await (await browser.newContext()).newPage();
  const admin = await (await browser.newContext()).newPage();
  // Schülerin und Mutter rufen absichtlich 404-Seiten auf (Konsolenmeldung des Browsers) – nur dort 404 zulassen
  const errorsOf = [collectErrors(jana), collectErrors(lea), collectErrors(mother), collectErrors(admin)];
  const SETTING = "Noten für Schüler:innen sichtbar";
  const region = () => admin.getByRole("region", { name: "Einstellungen Notenbuch" });

  // das Buch wieder abschließen (Halbjahresnoten erscheinen erst nach dem Abschluss)
  await login(jana, "jana.brandt");
  await jana.goto(bookPath);
  const abschluss = jana.getByRole("article").filter({ has: jana.getByRole("heading", { name: "Halbjahresabschluss" }) });
  await abschluss.getByRole("button", { name: "Abschließen und sperren" }).click();
  await abschluss.getByRole("button", { name: "Endgültig abschließen" }).click();
  await expect(abschluss).toContainText("Abgeschlossen am");

  // Vorgabe aus: keine Navigation, Seite 404
  await login(lea, "lea.schaefer");
  await expect(lea.getByRole("link", { name: "Noten", exact: true })).toHaveCount(0);
  expect((await lea.goto("/notenbuch"))!.status()).toBe(404);

  await login(admin, "admin");
  await admin.goto("/verwaltung/rechte");
  await region().getByLabel(SETTING).selectOption({ label: "nur Halbjahresnoten (nach dem Abschluss)" });
  await expect(region().getByLabel(SETTING)).toHaveValue("halbjahr");
  await admin.reload();
  await expect(region().getByLabel(SETTING)).toHaveValue("halbjahr");

  await lea.goto("/");
  await lea.getByRole("link", { name: "Noten", exact: true }).first().click();
  await expect(lea.getByRole("heading", { name: "Noten", exact: true })).toBeVisible();
  const deutsch = lea.getByRole("article", { name: /^Deutsch 2026\/27 1\. Halbjahr/ });
  await expect(deutsch).toContainText("Halbjahresnote");
  await expect(lea.locator("main")).not.toContainText("Gedichtanalyse");
  await expect(lea.locator("main")).not.toContainText("Mündlich");
  // Lehrkräfte-Seiten bleiben verborgen
  expect((await lea.goto(bookPath))!.status()).toBe(404);

  // Eltern: eigener Schalter (Vorgabe aus)
  await login(mother, "daniela.schaefer");
  expect((await mother.goto("/notenbuch"))!.status()).toBe(404);

  // zurück auf die Vorgabe (gemeinsame E2E-Datenbank)
  await admin.reload();
  await region().getByLabel(SETTING).selectOption({ label: "aus" });
  await expect(region().getByLabel(SETTING)).toHaveValue("aus");
  await admin.reload();
  await expect(region().getByLabel(SETTING)).toHaveValue("aus");
  expect((await lea.goto("/notenbuch"))!.status()).toBe(404);

  for (const e of errorsOf) expect(e.filter((m) => !/status of 404/.test(m))).toEqual([]);
  for (const pg of [jana, lea, mother, admin]) await pg.context().close();
});
