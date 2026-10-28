import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("Verwaltung · Stammdaten", () => {
  test("Schule: Freigabe nur für NRW – Hinweis beim Bundesland, Warnung bei anderem Land (ohne Speichern)", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/schule");
    await expect(page.getByText("SchulOS ist derzeit nur für Nordrhein-Westfalen freigegeben.")).toBeVisible();
    await page.getByLabel("Bundesland").selectOption("BY");
    await expect(page.getByRole("note").filter({ hasText: "Für Bayern sind die Vorlagen für Rechtsgrundlagen" })).toBeVisible();
    await page.getByLabel("Bundesland").selectOption("NW");
    await expect(page.getByRole("note").filter({ hasText: "Für Bayern" })).toHaveCount(0);
    // Übersicht: bei NRW keine Warnkarte
    await page.goto("/verwaltung");
    await expect(page.getByRole("heading", { name: "Bundesland nicht freigegeben" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Jahrgänge umbenennen, Fehler zeigen, zurücksetzen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung");
    await page.getByRole("navigation", { name: "Verwaltung" }).getByRole("link", { name: "Stammdaten", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Jahrgänge" })).toBeVisible();
    // Demo-Schule entspricht der Vorlage → kein Übernehmen-Knopf
    await expect(page.getByRole("button", { name: "Vorlage übernehmen" })).toHaveCount(0);
    await expect(page.getByLabel("Kürzel Jahrgang 11")).toHaveValue("EF");

    await page.getByLabel("Kürzel Jahrgang 5").fill("EF");
    await page.getByLabel("Name Jahrgang 6").fill("Sechser");
    await page.getByRole("button", { name: "Jahrgänge speichern" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Kürzel doppelt" })).toBeVisible();
    // Eingaben bleiben nach dem Fehler erhalten
    await expect(page.getByLabel("Name Jahrgang 6")).toHaveValue("Sechser");

    await page.getByLabel("Kürzel Jahrgang 5").fill("5");
    await page.getByRole("button", { name: "Jahrgänge speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Name Jahrgang 6")).toHaveValue("Sechser");
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-stammdaten.png", fullPage: true });

    await page.getByLabel("Name Jahrgang 6").fill("Jahrgang 6");
    await page.getByRole("button", { name: "Jahrgänge speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Fächer: anlegen, umbenennen, verschieben, löschen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=faecher");
    await expect(page.getByRole("heading", { name: "Fächer" })).toBeVisible();
    await expect(page.getByLabel("Raumart SP")).toHaveValue("sport");
    // verplante Fächer lassen sich nicht löschen
    await expect(page.getByRole("button", { name: "D löschen" })).toBeDisabled();

    await page.getByLabel("Kürzel neues Fach").fill("SN");
    await page.getByLabel("Name neues Fach").fill("Spanisch");
    await page.getByRole("button", { name: "Hinzufügen" }).click();
    await expect(page.getByLabel("Kürzel Spanisch")).toHaveValue("SN");
    await expect(page.getByLabel("Kürzel neues Fach")).toHaveValue("");

    // doppeltes Kürzel → Fehler, Eingaben bleiben
    await page.getByLabel("Kürzel Spanisch").fill("D");
    await page.getByRole("button", { name: "Fächer speichern" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Kürzel doppelt" })).toBeVisible();
    await expect(page.getByLabel("Kürzel Spanisch")).toHaveValue("D");

    await page.getByLabel("Kürzel Spanisch").fill("S");
    await page.getByRole("button", { name: "Fächer speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
    await expect(page.getByLabel("Kürzel Spanisch")).toHaveValue("S");

    const codes = () => page.locator('input[name^="code-"]:not([name="code-new"])').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    const before = await codes();
    expect(before.at(-1)).toBe("S");
    await page.getByRole("button", { name: "S nach oben" }).click();
    await expect.poll(codes).toEqual([...before.slice(0, -2), "S", before.at(-2)]);
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-faecher.png", fullPage: true });

    await page.getByRole("button", { name: "S löschen" }).click();
    await expect.poll(codes).toEqual(before.slice(0, -1));
    expect(errors).toEqual([]);
  });

  test("Zeitraster: Fehler zeigen, Stunde anhängen und wieder entfernen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=zeitraster");
    await expect(page.getByLabel("Beginn 1. Stunde")).toHaveValue("08:00");
    await expect(page.getByText("Pause · 20 Minuten").first()).toBeVisible();

    await page.getByLabel("Beginn 2. Stunde").fill("08:30");
    await page.getByRole("button", { name: "Zeitraster speichern" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Beginnt vor dem Ende der 1. Stunde" })).toBeVisible();
    await expect(page.getByLabel("Beginn 2. Stunde")).toHaveValue("08:30");
    await page.getByLabel("Beginn 2. Stunde").fill("08:50");

    const rows = await page.getByLabel(/^Beginn \d+\. Stunde$/).count();
    await page.getByRole("button", { name: "Stunde anhängen" }).click();
    await expect(page.getByLabel(`Beginn ${rows + 1}. Stunde`)).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-zeitraster.png", fullPage: true });
    await page.getByRole("button", { name: `${rows + 1}. Stunde entfernen` }).click();
    await expect(page.getByLabel(`Beginn ${rows + 1}. Stunde`)).toHaveCount(0);
    await expect(page.getByLabel("Beginn 2. Stunde")).toHaveValue("08:50");
    expect(errors).toEqual([]);
  });

  test("Räume: filtern, anlegen, umbenennen, deaktivieren, löschen", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=raeume");
    await expect(page.getByRole("row").filter({ hasText: "NW2" })).toContainText("Abzug");
    await page.getByLabel("Raumart", { exact: true }).selectOption("sport");
    await page.getByRole("button", { name: "Filtern" }).click();
    await expect(page).toHaveURL(/art=sport/);
    await expect(page.getByRole("link", { name: /^TH\d$/ })).toHaveCount(2);
    await expect(page.getByRole("link", { name: "NW2" })).toHaveCount(0);

    // verplanter Raum: Löschen gesperrt
    await page.goto("/verwaltung/stammdaten/raeume/101");
    await expect(page.getByRole("button", { name: "Löschen" })).toBeDisabled();

    await page.goto("/verwaltung/stammdaten?bereich=raeume");
    await page.getByRole("link", { name: "Raum anlegen" }).click();
    await page.getByLabel("Kürzel", { exact: true }).fill("NW2");
    await page.getByLabel("Name", { exact: true }).fill("Lernwerkstatt");
    await page.getByLabel("Raumart").selectOption("werkraum");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Kürzel schon vergeben" })).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Lernwerkstatt"); // Eingaben bleiben
    await page.getByLabel("Kürzel", { exact: true }).fill("LW1");
    await page.getByLabel("barrierefrei erreichbar").check();
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page).toHaveURL(/bereich=raeume/);
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "LW1" }) });
    await expect(row).toContainText("Werkraum");
    await expect(row.getByLabel("barrierefrei")).toBeVisible();

    await row.getByRole("link", { name: "LW1", exact: true }).click();
    await page.getByLabel("Kürzel", { exact: true }).fill("LW2");
    await page.getByRole("checkbox", { name: /^aktiv/ }).uncheck();
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page).toHaveURL(/bereich=raeume/);
    const row2 = page.getByRole("row").filter({ has: page.getByRole("link", { name: "LW2" }) });
    await expect(row2).toContainText("inaktiv");
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-raeume.png", fullPage: true });

    await row2.getByRole("link", { name: "LW2", exact: true }).click();
    await page.getByRole("button", { name: "Löschen" }).click();
    await expect(page).toHaveURL(/bereich=raeume/);
    await expect(page.getByRole("link", { name: "LW2", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Räume: Knopf Bearbeiten in der Liste, Stilllegen und Wiederinbetriebnahme", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=raeume");
    await page.getByRole("link", { name: "Raum 101 bearbeiten" }).click();
    await expect(page).toHaveURL(/raeume\/101$/);
    await page.getByRole("button", { name: "Raum stilllegen" }).click();
    await expect(page).toHaveURL(/bereich=raeume/);
    await expect(page.getByRole("row").filter({ has: page.getByRole("link", { name: "101", exact: true }) })).toContainText("inaktiv");
    await page.getByRole("link", { name: "Raum 101 bearbeiten" }).click();
    await page.getByRole("button", { name: "Raum wieder in Betrieb nehmen" }).click();
    await expect(page.getByRole("row").filter({ has: page.getByRole("link", { name: "101", exact: true }) })).not.toContainText("inaktiv");
    expect(errors).toEqual([]);
  });

  test("Räume: Raumbelegung und Raumsuche verlinken auf die Bearbeitung – nur mit Stammdaten-Recht", async ({ page, browser }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/stundenplan/raeume?ansicht=belegung");
    await page.getByRole("link", { name: "Raum 101 bearbeiten" }).click();
    await expect(page).toHaveURL(/verwaltung\/stammdaten\/raeume\/101$/);
    await page.goto("/stundenplan/raeume?von=1&bis=8");
    await expect(page.getByRole("link", { name: /^Raum .+ bearbeiten$/ }).first()).toBeVisible();
    expect(errors).toEqual([]);

    const ctx = await browser.newContext();
    const lehr = await ctx.newPage();
    await login(lehr, "jana.brandt");
    await lehr.goto("/stundenplan/raeume?ansicht=belegung");
    await expect(lehr.getByRole("columnheader", { name: /Auslastung/ })).toBeVisible();
    await expect(lehr.getByRole("link", { name: /^Raum .+ bearbeiten$/ })).toHaveCount(0);
    await lehr.goto("/stundenplan/raeume?von=1&bis=8");
    await expect(lehr.getByRole("link", { name: /^Raum .+ bearbeiten$/ })).toHaveCount(0);
    await ctx.close();
  });

  test("Schuljahre: Folgejahr anlegen, Halbjahr prüfen, löschen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=schuljahre");
    await expect(page.getByLabel("2026/27 ist das aktuelle Schuljahr")).toBeChecked();
    await expect(page.getByLabel("2. Halbjahr 2026/27")).toHaveValue("2027-02-01");
    await expect(page.getByRole("button", { name: "2026/27 löschen" })).toBeDisabled();

    await page.getByRole("button", { name: "Folgejahr anlegen" }).click();
    await expect(page.getByLabel("Name 2027/28")).toHaveValue("2027/28");
    await expect(page.getByLabel("Beginn 2027/28")).toHaveValue("2027-08-01");

    await page.getByLabel("2. Halbjahr 2027/28").fill("2029-02-01");
    await page.getByRole("button", { name: "Schuljahre speichern" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Muss innerhalb des Schuljahres liegen" })).toBeVisible();
    await expect(page.getByLabel("2. Halbjahr 2027/28")).toHaveValue("2029-02-01");
    await page.getByLabel("2. Halbjahr 2027/28").fill("2028-01-31");
    await page.getByRole("button", { name: "Schuljahre speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-schuljahre.png", fullPage: true });

    await page.getByRole("button", { name: "2027/28 löschen" }).click();
    await expect(page.getByLabel("Name 2027/28")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Ferien: automatischer Abruf mit Quelle, nächtlicher Abruf lässt sich aus- und einschalten", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=ferien");
    const box = page.getByLabel("Automatischer Ferienabruf");
    await expect(box).toContainText("Die Ferien für Nordrhein-Westfalen kommen jede Nacht aus der OpenHolidays API");
    await expect(box).toContainText("Noch nicht abgerufen.");
    await box.getByRole("button", { name: "Nächtlichen Abruf ausschalten" }).click();
    await expect(box).toContainText("nur auf Knopfdruck");
    await box.getByRole("button", { name: "Nächtlichen Abruf einschalten" }).click();
    await expect(box).toContainText("jede Nacht");
    expect(errors).toEqual([]);
  });

  test("Ferien anlegen → Wochenplan zeigt sie statt Stunden; Feiertage berechnet", async ({ page, browser }) => {
    const errors = collectErrors(page);
    // Montag der übernächsten Woche (unabhängig vom echten Datum, ohne Zeitzonen-Tricks: lokal rechnen reicht für Datumsteile)
    const d = new Date();
    d.setDate(d.getDate() + 14 - ((d.getDay() + 6) % 7));
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    const monday = iso(d);
    const friday = iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 4));

    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=ferien");
    await expect(page.getByRole("list", { name: "Feiertage" })).toContainText("1. Weihnachtstag");

    await page.getByLabel("Bezeichnung neuer Eintrag").fill("Testferien");
    await page.getByLabel("Von neuer Eintrag").fill(friday);
    await page.getByLabel("Bis neuer Eintrag").fill(monday);
    await page.getByRole("button", { name: "Hinzufügen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Ende vor dem Beginn" })).toBeVisible();
    await page.getByLabel("Von neuer Eintrag").fill(monday);
    await page.getByLabel("Bis neuer Eintrag").fill(friday);
    await page.getByRole("button", { name: "Hinzufügen" }).click();
    await expect(page.getByLabel("Bezeichnung Testferien")).toHaveValue("Testferien");

    const lea = await (await browser.newContext()).newPage();
    await login(lea, "lea.schaefer");
    await lea.goto(`/stundenplan?woche=${monday}`);
    await expect(lea.getByText("Testferien", { exact: true })).toBeVisible();
    await expect(lea.getByText("In dieser Woche ist kein Unterricht.")).toBeVisible();
    await lea.screenshot({ path: ".data/shots/e2e/stundenplan-ferien.png", fullPage: true });
    await lea.context().close();

    await page.screenshot({ path: ".data/shots/e2e/verwaltung-ferien.png", fullPage: true });
    await page.getByRole("button", { name: "Testferien löschen" }).click();
    await expect(page.getByLabel("Bezeichnung Testferien")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Stundentafel: Summe rechnet mit, speichern, Vorlage stellt wieder her; Zeitraster-Vorlage", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/stammdaten?bereich=stundentafel");
    const sum5 = page.getByTestId("sum-5");
    await expect(sum5).toHaveText("28");
    await expect(page.getByLabel("Französisch, Jahrgang 7")).toHaveValue("3");

    await page.getByLabel("Deutsch, Jahrgang 5").fill("6");
    await expect(sum5).toHaveText("30");
    // mehr als 12 Stunden blockiert schon der Browser (max), der Server prüft zusätzlich (Unit-Test)
    await page.getByLabel("Musik, Jahrgang 5").fill("13");
    expect(await page.getByLabel("Musik, Jahrgang 5").evaluate((el) => (el as HTMLInputElement).validity.rangeOverflow)).toBe(true);
    await page.getByLabel("Musik, Jahrgang 5").fill("2");
    await page.getByRole("button", { name: "Stundentafel speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
    await page.reload();
    await expect(sum5).toHaveText("30");
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-stundentafel.png", fullPage: true });

    await page.getByRole("button", { name: "Vorlage übernehmen" }).click();
    await expect(sum5).toHaveText("28");

    // Zeitraster: 60-Minuten-Vorlage hat nur 6 Stunden, im Demo-Plan ist die 7. verplant
    await page.goto("/verwaltung/stammdaten?bereich=zeitraster");
    await expect(page.getByLabel("Zeitraster-Vorlage")).toHaveValue("ganztag-45");
    await page.getByLabel("Zeitraster-Vorlage").selectOption("60");
    await page.getByRole("button", { name: "Vorlage übernehmen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "7. Stunde ist noch" })).toBeVisible();
    await expect(page.getByLabel("Beginn 8. Stunde")).toHaveValue("15:05");
    expect(errors).toEqual([]);
  });

  test("Kurs mit Jahrgang und Niveau anlegen, Liste zeigt Kürzel", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/gruppen/neu");
    await page.getByLabel("Name", { exact: true }).fill("Mathe Q1 LK Test");
    await page.getByLabel("Art", { exact: true }).selectOption("kurs");
    await page.getByLabel("Jahrgang", { exact: true }).selectOption({ label: "Q1 – Qualifikationsphase 1" });
    await page.getByLabel("Niveau", { exact: true }).selectOption("LK");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("heading", { name: "Mathe Q1 LK Test" })).toBeVisible();

    await page.goto("/verwaltung/gruppen?art=kurs");
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Mathe Q1 LK Test" }) });
    await expect(row).toContainText("Q1 · LK");

    await row.getByRole("link").click();
    await expect(page.getByRole("heading", { name: "Mathe Q1 LK Test" })).toBeVisible();
    await page.getByRole("button", { name: "Löschen" }).click();
    await expect(page).toHaveURL("/verwaltung/gruppen");
    expect(errors).toEqual([]);
  });
});
