import { expect, test } from "@playwright/test";
import { collectErrors, login, pickTeacher, publishIfDraft, sendPlannedNow, undoAndDiscardVersion } from "./helpers";

test("Stundenplanung pflegt den Stundenplan und bekommt Kollisionen gemeldet", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Stundenplanung" }).click();
  await page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Stundenplan", exact: true }).click();
  await page.getByLabel("Klasse oder Kurs").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Anzeigen" }).click();

  await page.getByRole("link", { name: "Stunde anlegen: Fr 8. Stunde" }).click();
  await page.getByLabel("Fach", { exact: true }).selectOption({ label: "Informatik" });
  await pickTeacher(page, "teacherId", "u-benedikt.lange");
  await page.getByLabel("Raum").selectOption({ label: "IF1 – Informatik-Raum" });
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("link", { name: /Informatik LAN · IF1/ })).toBeVisible();

  // gleiche Lehrkraft zur gleichen Zeit in einer anderen Klasse → Kollision
  await page.getByLabel("Klasse oder Kurs").selectOption({ label: "Klasse 9a" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await page.getByRole("link", { name: "Stunde anlegen: Fr 8. Stunde" }).click();
  await page.getByLabel("Fach", { exact: true }).selectOption({ label: "Mathematik" });
  await pickTeacher(page, "teacherId", "u-benedikt.lange");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText("LAN unterrichtet Fr 8. Stunde schon in Klasse 7b");
  // Eingaben bleiben nach dem Fehler erhalten
  await expect(page.getByLabel("Fach", { exact: true })).toHaveValue("M");
  await expect(page.getByLabel("Lehrkraft")).toHaveValue("u-benedikt.lange");
  await page.screenshot({ path: ".data/shots/e2e/stundenplan-pflege.png", fullPage: true });

  // in der 7b wieder löschen
  await page.getByLabel("Klasse oder Kurs").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await page.getByRole("link", { name: /Informatik LAN · IF1/ }).click();
  await page.getByRole("button", { name: "Stunde löschen" }).click();
  await expect(page.getByRole("link", { name: /Informatik LAN · IF1/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Schüler:innen erreichen die Pflege nicht", async ({ page }) => {
  await login(page, "lea.schaefer");
  const res = await page.goto("/planung/stundenplan");
  expect(res?.status()).toBe(404);
});

test("Schülerin sieht die Tagesleiste auf „Heute“ und ihren Wochenplan", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  const strip = page.getByRole("region", { name: "Tagesleiste" });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("heading", { level: 2 })).toContainText(/Stunden(, davon .+)? · [AB]-Woche/);
  // abends zeigt die Leiste „Morgen“ – die Zahl hängt vom Tag ab; sie muss zur Überschrift passen (vorher fest ≥ 5, abends rot)
  const announced = Number(/(\d+) Stunden/.exec((await strip.getByRole("heading", { level: 2 }).textContent()) ?? "")![1]);
  expect(announced).toBeGreaterThanOrEqual(1);
  expect(await strip.locator("article").count()).toBe(announced);
  await page.screenshot({ path: ".data/shots/e2e/heute-tagesleiste.png" });

  await strip.getByRole("link", { name: "Wochenplan" }).click();
  await expect(page.getByRole("heading", { name: "Mein Stundenplan" })).toBeVisible();
  await expect(page.getByText(/KW \d+ · [AB]-Woche/)).toBeVisible();
  await expect(page.getByText("Deutsch").first()).toBeVisible();
  await page.getByRole("link", { name: "Nächste Woche" }).click();
  await expect(page.getByRole("link", { name: "Diese Woche" })).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/stundenplan-woche.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("Lehrkraft sieht eigene Stunden und den Raumplan; Schüler:innen keine fremden Pläne", async ({ page, browser }) => {
  await login(page, "jana.brandt");
  await page.goto("/stundenplan");
  await expect(page.getByRole("heading", { name: "Mein Stundenplan" })).toBeVisible();
  await expect(page.getByRole("table").getByText("Klasse 7b").first()).toBeVisible();
  await page.getByLabel("Raum").selectOption("NW1");
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await expect(page.getByRole("heading", { name: "Raum NW1" })).toBeVisible();
  await expect(page.getByRole("table").getByText("Biologie").first()).toBeVisible();

  const ctx = await browser.newContext();
  const lea = await ctx.newPage();
  await login(lea, "lea.schaefer");
  const res = await lea.goto("/stundenplan?raum=NW1");
  expect(res?.status()).toBe(404);
  await ctx.close();
});

/** Montag in zwei Wochen – weit weg von den Demo-Vertretungen am nächsten Schultag */
function mondayInTwoWeeks(): string {
  const d = new Date();
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd + 14);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("Vertretung eintragen: Klasse bekommt Gong und sieht die Stunde orange im Plan", async ({ page, browser }) => {
  const errors = collectErrors(page);
  const date = mondayInTwoWeeks();
  await login(page, "frank.schulte");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Stundenplanung" }).click();
  await page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Vertretungen" }).click();
  await page.getByLabel("Datum").fill(date);
  await page.getByLabel("oder Klasse/Kurs").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Anzeigen" }).click();

  const form = page.getByRole("form", { name: /^1\. Std · / });
  await expect(form).toBeVisible();
  const firstFree = await form.locator('optgroup[label="Frei"] option').first().getAttribute("value");
  await form.getByLabel("Vertretung durch").selectOption(firstFree!);
  await form.getByLabel("Hinweis").fill("Lies Kapitel 3");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await expect(form.getByLabel("Vertretung durch")).toHaveValue(firstFree!);
  await expect(page.getByRole("row", { name: /Klasse 7b.*Vertretung.*Lies Kapitel 3/ })).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/vertretungen-pflege.png", fullPage: true });
  // Q5-11: Demo-Schule mit Freigabe – der Tag in zwei Wochen ist ein Entwurf, erst nach dem Veröffentlichen kommt der Gong
  await expect(page.getByRole("article", { name: "Entwurf" })).toBeVisible();
  await publishIfDraft(page);
  // VT-04: der Gong für den Tag in zwei Wochen ist für den Vortag eingeplant – jetzt senden
  await sendPlannedNow(page);

  const ctx = await browser.newContext();
  const lea = await ctx.newPage();
  await login(lea, "lea.schaefer");
  await lea.getByRole("button", { name: /Gong/ }).click();
  // Q5-03: eine Nachricht je Tag – einzeln oder als Zeile der Tagesübersicht
  await expect(lea.getByText(/^Vertretung .*1\. Std: |(^| · )1\. Std [^·]*: Vertretung/).first()).toBeVisible();
  await lea.goto(`/stundenplan?woche=${date}`);
  const chip = lea.getByRole("table").locator('[data-tone="sub"]').first();
  await expect(chip).toContainText("Vertretung · Lies Kapitel 3");
  await lea.screenshot({ path: ".data/shots/e2e/stundenplan-vertretung.png", fullPage: true });
  await ctx.close();
  expect(errors).toEqual([]);
});

test("Vertretungsplan zeigt Änderungen nach Klasse, eigene Klasse zuerst", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  await page.goto("/stundenplan");
  await page.getByRole("link", { name: "Vertretungsplan" }).click();
  await expect(page.getByRole("heading", { name: "Vertretungsplan", level: 1 })).toBeVisible();
  // zwei Tage sind zu sehen; die Demo-Vertretung liegt auf dem nächsten Schultag – an manchen Tagen hat die 7b schon heute
  // eine andere Änderung (z. B. Raumsperrung). Deshalb: irgendeine 7b-Karte mit der Vertretung, jede 7b-Karte als eigene Klasse.
  const mine = page.getByRole("article", { name: "Klasse 7b" });
  await expect(mine.first()).toContainText("Deine Klasse");
  await expect(mine.filter({ hasText: "Vertretung" }).first()).toContainText("Deine Klasse");
  await expect(page.getByRole("article", { name: "Klasse 9b" }).filter({ hasText: "Entfall" }).first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/vertretungsplan.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("Kopplung: geteilte Klasse und eine Lehrkraft für zwei Klassen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  await page.getByRole("link", { name: "Stunde anlegen: Fr 8. Stunde" }).click();
  await page.getByRole("link", { name: "Stattdessen Kopplung anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Kopplung anlegen · Klasse 7b" })).toBeVisible();
  await expect(page.getByLabel("Gruppe 1")).toHaveValue("g-7b");

  await page.getByLabel("Fach 1").selectOption({ label: "Religion/Philosophie" });
  await pickTeacher(page, "p0-teacherId", "u-jonas.richter");
  await page.getByLabel("Raum 1").selectOption("110");
  await page.getByLabel("Gruppe 2").selectOption({ label: "Klasse 7a" });
  await page.getByLabel("Fach 2").selectOption({ label: "Religion/Philosophie" });
  await pickTeacher(page, "p1-teacherId", "u-jonas.richter");
  await page.getByLabel("Raum 2").selectOption("111");
  await page.getByRole("button", { name: "Teil hinzufügen" }).click();
  await page.getByLabel("Gruppe 3").selectOption({ label: "Klasse 7b" });
  await page.getByLabel("Fach 3").selectOption({ label: "Deutsch" });
  await pickTeacher(page, "p2-teacherId", "u-jana.brandt");
  await page.getByRole("button", { name: "Kopplung speichern" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText("Dieselbe Lehrkraft kann nicht in zwei Räumen sein");
  // Zeilen und Eingaben bleiben nach dem Fehler erhalten
  await expect(page.getByLabel("Lehrkraft 3")).toHaveValue("u-jana.brandt");
  await page.getByLabel("Raum 2").selectOption("110");
  await page.getByRole("button", { name: "Kopplung speichern" }).click();
  await expect(page).not.toHaveURL(/kopplung=/);
  const cell = page.getByRole("link", { name: /Religion\/Philosophie RIC · 110/ });
  await expect(cell).toContainText("Kopplung · 7a, 7b");
  await expect(page.getByRole("link", { name: /Deutsch BRA/ }).filter({ hasText: "Kopplung" })).toHaveCount(1);
  await page.screenshot({ path: ".data/shots/e2e/stundenplan-kopplung.png", fullPage: true });

  // Plan der Lehrkraft: eine Stunde für beide Klassen
  await page.goto("/stundenplan?lehrkraft=u-jonas.richter");
  await expect(page.getByText("7a, 7b · R 110").first()).toBeVisible();
  await expect(page.getByText("Klasse 7b · R 110")).toHaveCount(0);

  // Vertretung für RIC in der 7a gilt auch für die 7b (gleiche Lehrkraft in der Kopplung)
  const friday = addDaysYmd(mondayInTwoWeeks(), 4);
  await page.goto("/planung/vertretungen");
  await page.getByLabel("Datum").fill(friday);
  await page.getByLabel("oder Klasse/Kurs").selectOption({ label: "Klasse 7a" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  const form = page.getByRole("form", { name: /^8\. Std · / });
  const free = await form.locator('optgroup[label="Frei"] option').first().getAttribute("value");
  await form.getByLabel("Vertretung durch").selectOption(free!);
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  // nur in „Alle Änderungen am …“ suchen: die Karte „Abwesenheit beendet – prüfen“ (SP2-16b) kann Zeilen aus Vorläufer-Specs zeigen
  // (gate2b hebt die Abwesenheit von BRA auf, dienstags steht deren Vertretung in der 7a dann dort)
  const changes = page.getByRole("region", { name: /^Alle Änderungen am/ });
  await expect(changes.getByRole("row", { name: /Klasse 7a.*Vertretung/ })).toBeVisible();
  await expect(changes.getByRole("row", { name: /Klasse 7b.*Vertretung/ })).toBeVisible();

  // ganze Kopplung löschen
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  await cell.click();
  await expect(page.getByRole("heading", { name: "Kopplung bearbeiten · Klasse 7b" })).toBeVisible();
  await page.getByRole("button", { name: "Kopplung löschen" }).click();
  await expect(page.getByRole("link", { name: /Religion\/Philosophie RIC · 110/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Raumvorschlag beim Setzen: Fachraum nach Raumwunsch, sonst Stammraum der Klasse", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  await page.getByRole("link", { name: "Stunde anlegen: Fr 8. Stunde" }).click();
  await page.getByLabel("Fach", { exact: true }).selectOption({ label: "Biologie" });
  await expect(page.getByLabel("Raum")).toHaveValue("NW1");
  await page.getByLabel("Fach", { exact: true }).selectOption({ label: "Deutsch" });
  await expect(page.getByLabel("Raum")).toHaveValue("106");
  // selbst gewählter Raum bleibt
  await page.getByLabel("Raum").selectOption("201");
  await page.getByLabel("Fach", { exact: true }).selectOption({ label: "Sport" });
  await expect(page.getByLabel("Raum")).toHaveValue("201");
  expect(errors).toEqual([]);
});

test("Setzhilfe: offene Stunden setzen, belegte Felder mit Grund, Stunde tauschen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  // neuer Lehrauftrag ohne Stunden im Plan
  await page.goto("/planung/unterricht?gruppe=g-6b&neu=1");
  await page.getByLabel("Fach").selectOption({ label: "Französisch" });
  await page.getByLabel("Wochenstunden").fill("2");
  await pickTeacher(page, "teacherId", "u-sophie.wagner");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page).not.toHaveURL(/neu=/);

  await page.goto("/planung/stundenplan?gruppe=g-6b");
  const panel = page.getByRole("article", { name: "Offene Stunden" });
  await panel.getByRole("link", { name: /^Französisch · WAG.*2 von 2 offen/ }).click();
  await expect(page).toHaveURL(/setzen=/);
  // belegte Felder nennen den Grund
  await expect(page.getByRole("list", { name: / belegt$/ }).filter({ hasText: "Klasse 6b hat" }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Hier setzen: / }).first().click();
  await expect(panel.getByRole("link", { name: /^Französisch · WAG.*1 von 2 offen/ })).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/stundenplan-setzhilfe.png", fullPage: true });
  await page.getByRole("button", { name: /^Hier setzen: / }).first().click();
  await expect(page).not.toHaveURL(/setzen=/);
  await expect(panel.getByText("Alle Lehraufträge sind im Stundenplan verplant.")).toBeVisible();
  const french = page.getByRole("link", { name: /^Französisch WAG/ });
  await expect(french).toHaveCount(2);

  // Verschieben/Tauschen
  await french.first().click();
  await page.getByRole("link", { name: "Verschieben oder tauschen" }).click();
  await expect(page.getByRole("heading", { name: /^Verschieben: Französisch \(WAG\)/ })).toBeVisible();
  await expect(page.getByText("hier liegt die Stunde")).toBeVisible();
  await page.getByRole("button", { name: /tauschen mit/ }).first().click();
  await expect(page).not.toHaveURL(/verschieben=/);
  await expect(french).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("Druckansichten: Regelplan und Woche der Klasse, Vertretungsplan; Schülerin nur eigene Pläne", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/stundenplan?gruppe=g-7b");
  await page.getByRole("link", { name: "Drucken" }).click();
  await expect(page).toHaveURL(/\/druck\/stundenplan\?gruppe=g-7b/);
  await expect(page.getByRole("heading", { name: "Klasse 7b", level: 1 })).toBeVisible();
  await expect(page.getByText(/^Regelplan · Stand/)).toBeVisible();
  await expect(page.getByRole("table").getByText("Deutsch").first()).toBeVisible();
  // ohne Shell: keine Seitennavigation
  await expect(page.getByRole("link", { name: "Klassenbuch" })).toHaveCount(0);
  await page.getByRole("link", { name: "Woche mit Vertretungen" }).click();
  await expect(page.getByText(/^KW \d+ .* mit Vertretungen$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Drucken / als PDF speichern" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("navigation", { name: "Druckoptionen" })).toBeHidden();
  await page.screenshot({ path: ".data/shots/e2e/druck-stundenplan.png", fullPage: true });
  await page.emulateMedia({ media: "screen" });

  await page.goto("/stundenplan/vertretungen");
  await page.getByRole("link", { name: "Drucken" }).click();
  await expect(page.getByRole("heading", { name: "Vertretungsplan", level: 1 })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Entfall" }).first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/druck-vertretungsplan.png", fullPage: true });
  expect(errors).toEqual([]);

  // Schülerin: eigener Plan ja, fremde Klasse nicht
  await page.context().clearCookies();
  await login(page, "lea.schaefer");
  await page.goto("/druck/stundenplan");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Lea");
  const res = await page.goto("/druck/stundenplan?gruppe=g-9a");
  expect(res?.status()).toBe(404);
});

test("Räume: Raumsuche mit Filtern, Belegung aller Räume mit Auslastung; nur Personal", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await nav.getByRole("link", { name: "Räume" }).click();
  await expect(page.getByRole("heading", { name: "Räume", level: 1 })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Räume" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Stundenplan", exact: true })).not.toHaveAttribute("aria-current", "page");

  const form = page.getByRole("form", { name: "Raumsuche" });
  await form.getByLabel("von Stunde").selectOption("3");
  await form.getByLabel("bis Stunde").selectOption("4");
  await form.getByLabel("Raumart").selectOption({ label: "Naturwissenschaften" });
  await form.getByLabel("Mindestens Plätze").fill("20");
  await form.getByRole("button", { name: "Freie Räume suchen" }).click();
  await expect(page).toHaveURL(/von=3/);
  await expect(page.getByRole("heading", { name: /(Kein Raum frei|\d+ (Raum|Räume) frei) · .*3\.–4\. Stunde/ })).toBeVisible();
  // Treffer sind NW-Räume; Filter bleiben stehen
  for (const cell of await page.getByRole("table").getByRole("cell", { name: "Naturwissenschaften" }).all()) await expect(cell).toBeVisible();
  await expect(form.getByLabel("Raumart")).toHaveValue("nw");
  await page.screenshot({ path: ".data/shots/e2e/raeume-suche.png", fullPage: true });

  await page.getByRole("link", { name: "Belegung" }).click();
  const table = page.getByRole("table", { name: /Belegung aller Räume/ });
  await expect(table.getByRole("rowheader", { name: /^106/ })).toBeVisible();
  await expect(table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: /^106/ }) }).getByText(/\d+ %/)).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/raeume-belegung.png", fullPage: true });
  expect(errors).toEqual([]);

  await page.context().clearCookies();
  await login(page, "lea.schaefer");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Räume" })).toHaveCount(0);
  expect((await page.goto("/stundenplan/raeume"))?.status()).toBe(404);
});

test("Raumsperrung: betroffene Stunden mit Ausweichraum verlegen, Belegung zeigt gesperrt, aufheben", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/stundenplan/raeume");
  await page.getByRole("link", { name: "Sperrungen" }).click();
  const form = page.getByRole("form", { name: "Raum sperren" });
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const inAWeek = new Date(Date.now() + 6 * 86_400_000);
  // Fehler: Ende vor Beginn
  await form.getByLabel("Raum").selectOption("106");
  await form.getByLabel("bis Tag").fill("2020-01-01");
  await form.getByLabel("Grund").selectOption({ label: "Prüfung" });
  await form.getByRole("button", { name: "Raum sperren" }).click();
  await expect(form.getByRole("alert")).toContainText("Ende liegt vor dem Beginn");
  await form.getByLabel("bis Tag").fill(ymd(inAWeek));
  await form.getByLabel("Ergänzung").fill("Lernstandserhebung");
  await form.getByRole("button", { name: "Raum sperren" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Raum gesperrt." })).toBeVisible();

  const blocks = page.getByRole("table", { name: "Raumsperrungen" });
  await expect(blocks.getByRole("row").filter({ hasText: "106" })).toContainText("Prüfung · Lernstandserhebung");
  const affected = page.getByRole("table", { name: "Stunden in gesperrten Räumen" });
  await expect(page.getByText(/\d+ ohne Ausweichraum/)).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/raeume-sperrung.png", fullPage: true });
  const before = await affected.getByText("verlegt", { exact: true }).count();
  await affected.getByRole("button", { name: /verlegen$/ }).first().click();
  await expect(affected.getByText("verlegt", { exact: true })).toHaveCount(before + 1);

  // Belegung: 106 ist gesperrt
  await page.getByRole("link", { name: "Belegung" }).click();
  const row106 = page.getByRole("table", { name: /Belegung aller Räume/ }).getByRole("row").filter({ has: page.getByRole("rowheader", { name: /^106/ }) });
  await expect(row106.getByText("Gesperrt: Prüfung (Lernstandserhebung)").first()).toBeVisible();

  await page.getByRole("link", { name: "Sperrungen" }).click();
  await page.getByRole("button", { name: "Sperrung 106 aufheben" }).click();
  await expect(page.getByText("Keine Sperrungen")).toBeVisible();
  await expect(page.getByText("Keine Stunde liegt in einem gesperrten Raum.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Automatisch planen: Stunde fixieren, Lauf mit Fortschritt, Bewertung und Vorschau, Übernahme prüft den Stichtag", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  await page.getByRole("link", { name: /^Deutsch BRA/ }).first().click();
  await page.getByRole("button", { name: "Fixieren" }).click();
  await expect(page.getByText("fixiert", { exact: true }).first()).toBeVisible();

  await page.getByRole("main").getByRole("link", { name: "Automatisch planen" }).click();
  await expect(page.getByRole("heading", { name: "Automatisch planen", level: 1 })).toBeVisible();
  await expect(page.getByText(/Fixierte Stunden \(1\)/)).toBeVisible();
  await page.getByLabel("Gründlichkeit").selectOption("schnell");
  await page.getByRole("button", { name: "Plan berechnen" }).click();
  // SP-07: weiter auf die Detailseite des Laufs; sie fragt den Zustand nach und lädt das Ergebnis, sobald der Lauf fertig ist
  await expect(page).toHaveURL(/\/planung\/solver\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: "Was die Bewertung kostet" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Hohlstunden Klassen", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nicht gesetzt" })).toBeVisible();
  await expect(page.getByText("Alle Einheiten sind gesetzt.")).toBeVisible();
  await page.getByLabel("Klasse, Kurs oder Lehrkraft").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  const preview = page.getByRole("table", { name: "Vorschlag Klasse 7b" });
  await expect(preview.getByText("Mathematik").first()).toBeVisible();
  await expect(preview.getByText(/BRA · 106 · bleibt/)).toHaveCount(1);
  await page.screenshot({ path: ".data/shots/e2e/solver.png", fullPage: true });

  // Stichtag in der Vergangenheit wird abgelehnt (der Demo-Plan bleibt für die anderen Tests unverändert) – SP3-04: übernommen wird nur
  // in einen Entwurf (neuer Entwurf ab Stichtag), die direkte Übernahme in den gültigen Plan gibt es nicht mehr
  await expect(page.getByRole("form", { name: "Vorschlag übernehmen" })).toHaveCount(0);
  const apply = page.getByRole("form", { name: "In den Entwurf übernehmen" });
  await apply.getByLabel("Entwurf", { exact: true }).selectOption("neu");
  await apply.getByLabel("Stichtag (nur neuer Entwurf)").fill("2020-01-06");
  await apply.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Stichtag/ })).toBeVisible();
  await page.getByRole("link", { name: "Alle Läufe" }).click();
  await expect(page.getByRole("table", { name: /Läufe der automatischen Planung/ }).getByText("fertig").first()).toBeVisible();

  await page.goto("/planung/stundenplan?gruppe=g-7b");
  await page.getByRole("link", { name: /^Deutsch BRA.*fixiert/ }).first().click();
  await page.getByRole("button", { name: "Lösen" }).click();
  await expect(page.getByText("fixiert", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// SP3-05: ersetzt „Periode kopieren“ – der Halbjahreswechsel ist die Vorlage „Neues Halbjahr“ (Entwurf aus dem gültigen Plan ab dem 2. Halbjahr);
// der gültige Plan bleibt bis zum Veröffentlichen unverändert, neue Stunden im Entwurf gelten ab dem Stichtag.
test("Halbjahres-Vorlage: Entwurf ab dem 2. Halbjahr, Plan ab Stichtag ändern ohne den laufenden", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/stundenplan");
  // „Periode kopieren“ gibt es nicht mehr – der Weg führt über die Vorlage
  await expect(page.getByRole("article", { name: "Neue Periode (Halbjahreswechsel)" })).toHaveCount(0);
  await page.getByRole("article", { name: "Halbjahreswechsel" }).getByRole("link", { name: "Planversionen" }).click();
  const template = page.getByRole("article", { name: "Neues Halbjahr" });
  await expect(template).toBeVisible();
  const create = template.getByRole("button", { name: "Entwurf fürs Halbjahr anlegen" });
  // die Demo-Schule hat ein 2. Halbjahr; ist es (nach dem echten Datum) schon angebrochen, nennt die Vorlage den Grund
  if ((await create.count()) === 0) {
    await expect(template).toContainText("hat schon begonnen");
    expect(errors).toEqual([]);
    return;
  }
  const label = (await template.getByTestId("vorlage-halbjahr").textContent())!;
  expect(label).toMatch(/^Version \d+\.0 ab \d\d\.\d\d\.\d{4}$/);
  const shown = /ab (\d\d\.\d\d\.\d{4})/.exec(label)![1]!;
  const cutoff = shown.split(".").reverse().join("-");
  await create.click();
  const status = page.getByRole("status").filter({ hasText: "„2. Halbjahr“ angelegt" });
  await expect(status).toBeVisible();
  await expect(status.getByRole("navigation", { name: "Nächste Schritte" })).toContainText(`Automatisch planen (Lehraufträge am ${shown})`);
  await page.screenshot({ path: ".data/shots/e2e/stundenplan-halbjahr.png", fullPage: true });
  await status.getByRole("link", { name: "Im Entwurf arbeiten" }).click();
  await expect(page).toHaveURL(/\/planung\/stundenplan\?quelle=[\w-]+$/);
  const versionId = new URL(page.url()).searchParams.get("quelle")!;

  // im Entwurf: neue Stunde gilt ab dem Stichtag
  await page.goto(`/planung/stundenplan?gruppe=g-7b&quelle=${versionId}`);
  await expect(page.getByTestId("entwurf-hinweis")).toContainText(`ab ${shown}`);
  await page.getByRole("link", { name: "Stunde anlegen: Fr 8. Stunde" }).click();
  await expect(page.getByLabel("Gültig ab")).toHaveValue(cutoff);
  await page.getByLabel("Fach", { exact: true }).selectOption({ label: "Informatik" });
  await pickTeacher(page, "teacherId", "u-benedikt.lange");
  await page.getByLabel("Raum").selectOption({ label: "IF1 – Informatik-Raum" });
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("link", { name: /Informatik LAN · IF1/ })).toBeVisible();
  // der gültige Plan bleibt, wie er ist – heute und ab dem Stichtag
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  await expect(page.getByRole("link", { name: /Informatik LAN · IF1/ })).toHaveCount(0);
  await page.goto(`/planung/stundenplan?gruppe=g-7b&stand=${cutoff}`);
  await expect(page.getByRole("link", { name: /Informatik LAN · IF1/ })).toHaveCount(0);

  // aufräumen: Entwurf verwerfen
  await undoAndDiscardVersion(page, versionId);
  expect(errors).toEqual([]);
});

// Q5-28 (Befund 0.5.0): Klasse, Lehrkraft und Raum stehen in einem Formular – nach „Klasse“ blieb die Wahl einer Lehrkraft
// wirkungslos (die Klasse hat Vorrang). Jede Wahl leert die anderen beiden Felder.
test("Planwahl: Wechsel Klasse → Lehrkraft → Raum → Klasse zeigt jeweils den gewählten Plan", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/stundenplan");
  const gruppe = page.getByLabel("Klasse oder Kurs");
  const lehrkraft = page.getByLabel("Lehrkraft", { exact: true });
  const raum = page.getByLabel("Raum", { exact: true });
  const anzeigen = page.getByRole("button", { name: "Anzeigen" });

  await gruppe.selectOption("g-7b");
  await anzeigen.click();
  await expect(page.getByRole("heading", { name: "Klasse 7b", level: 1 })).toBeVisible();

  // erst nach der Hydrierung leert die Wahl die anderen Felder – bis dahin wiederholen
  await expect(async () => {
    await lehrkraft.selectOption("u-jonas.richter");
    await expect(gruppe).toHaveValue("", { timeout: 500 });
  }).toPass();
  await anzeigen.click();
  await expect(page).toHaveURL(/lehrkraft=u-jonas\.richter/);
  await expect(page).not.toHaveURL(/gruppe=g-/);
  await expect(page.getByRole("heading", { name: "Jonas Richter", level: 1 })).toBeVisible();

  await expect(async () => {
    await raum.selectOption("NW1");
    await expect(lehrkraft).toHaveValue("", { timeout: 500 });
  }).toPass();
  await anzeigen.click();
  await expect(page.getByRole("heading", { name: "Raum NW1", level: 1 })).toBeVisible();

  await expect(async () => {
    await gruppe.selectOption("g-9a");
    await expect(raum).toHaveValue("", { timeout: 500 });
  }).toPass();
  await anzeigen.click();
  await expect(page.getByRole("heading", { name: "Klasse 9a", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});
