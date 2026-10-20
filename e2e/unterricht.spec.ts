import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("Stundenplanung · Unterrichtsverteilung", () => {
  test("Soll/verplant je Klasse und Lehrkraft, Lehrauftrag anlegen, Fehler, löschen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Stundenplanung" }).click();
    await page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Unterrichtsverteilung" }).click();
    await expect(page.getByRole("heading", { name: "Unterrichtsverteilung", level: 1 })).toBeVisible();
    // Demo: alle Stunden haben einen Lehrauftrag
    await expect(page.getByRole("button", { name: /Aus Stundenplan übernehmen/ })).toHaveCount(0);
    const row7b = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Klasse 7b", exact: true }) });
    await expect(row7b.getByText("vollständig verplant")).toHaveCount(1);

    await row7b.getByRole("link", { name: "Klasse 7b" }).click();
    await expect(page.getByRole("heading", { name: "Klasse 7b", level: 2 })).toBeVisible();
    await expect(page.getByText("Die Lehraufträge entsprechen der Stundentafel.")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Deutsch" }).getByRole("cell", { name: "BRA" })).toBeVisible();

    // neuer Lehrauftrag: Gruppe ist vorbelegt; zu viele Doppelstunden → Fehler, Eingaben bleiben
    await page.getByRole("link", { name: "Lehrauftrag anlegen" }).click();
    await expect(page.getByLabel("Klasse oder Kurs")).toHaveValue("g-7b");
    await page.getByLabel("Fach").selectOption({ label: "Französisch" });
    await page.getByLabel("Wochenstunden").fill("3");
    await page.getByLabel("Doppelstunden je Woche").fill("2");
    await page.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
    await page.getByLabel("Hinweis").fill("Zweite Fremdsprache");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "höchstens 1 Doppelstunden" })).toBeVisible();
    await expect(page.getByLabel("Hinweis")).toHaveValue("Zweite Fremdsprache");

    await page.getByLabel("Doppelstunden je Woche").fill("1");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page).not.toHaveURL(/neu=/);
    const row = page.getByRole("row").filter({ hasText: "Französisch" });
    await expect(row.getByText("3 offen")).toHaveCount(1);
    await expect(row.getByText("1× Doppelstunde")).toBeVisible();
    await expect(page.getByText("Die Lehraufträge entsprechen der Stundentafel.")).toHaveCount(0);
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-unterricht.png", fullPage: true });

    // Lehrkraft-Sicht zeigt den Auftrag
    await page.getByRole("link", { name: "Lehrkräfte", exact: true }).click();
    await page.getByRole("link", { name: "BRA", exact: true }).click();
    await expect(page.getByRole("heading", { name: "BRA · Jana Brandt" })).toBeVisible();
    const janaRow = page.getByRole("row").filter({ hasText: "Französisch" });
    await expect(janaRow.getByRole("cell", { name: "Klasse 7b" })).toBeVisible();

    // bearbeiten → löschen
    await janaRow.getByRole("link", { name: "Französisch" }).click();
    await expect(page.getByLabel("Wochenstunden")).toHaveValue("3");
    await page.getByRole("button", { name: "Lehrauftrag löschen" }).click();
    await expect(page).not.toHaveURL(/auftrag=/);
    await expect(page.getByRole("row").filter({ hasText: "Französisch" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("SP2-01 Bänder: Demo-Schiene, Band anlegen, Lehrauftrag im Band übernimmt die Stunden, herausnehmen, löschen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto("/planung/unterricht");
    await page.getByRole("navigation", { name: "Ansicht" }).getByRole("link", { name: "Bänder" }).click();
    await expect(page.getByRole("heading", { name: "Bänder", level: 2 })).toBeVisible();
    const demo = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Q1 GK-Schiene A" }) });
    await expect(demo.getByText(/Q1 Biologie GK1 · Biologie/)).toBeVisible();
    // SP2-02: der Solver setzt das Band als Einheit – vollständig verplant, alle Stunden zur selben Zeit
    await expect(demo.getByText("vollständig verplant")).toHaveCount(1);
    await expect(demo.getByText(/zur selben Zeit/)).toHaveCount(0);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    // anlegen: Name doppelt → Fehler, dann richtig
    await page.getByRole("link", { name: "Band anlegen" }).click();
    await page.getByLabel("Name des Bands").fill("Q1 GK-Schiene A");
    await page.getByRole("button", { name: "Band speichern" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "gibt es schon" })).toBeVisible();
    await page.getByLabel("Name des Bands").fill("Französisch 7 Test");
    await page.getByLabel("Wochenstunden").fill("2");
    await page.getByRole("button", { name: "Band speichern" }).click();
    await expect(page.getByRole("heading", { name: "Band bearbeiten · Französisch 7 Test" })).toBeVisible();
    await expect(page.getByText(/Noch keine – unten einen Lehrauftrag aufnehmen/)).toBeVisible();

    // Lehrauftrag mit Band: Stunden kommen vom Band
    await page.goto("/planung/unterricht?gruppe=g-7b&neu=1");
    await page.getByLabel("Fach").selectOption({ label: "Französisch" });
    await page.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
    await page.getByLabel("Band", { exact: true }).selectOption({ label: "Französisch 7 Test (2 Std.)" });
    await expect(page.getByLabel("Wochenstunden")).toBeDisabled();
    await expect(page.getByLabel("Wochenstunden")).toHaveValue("2");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page).not.toHaveURL(/neu=/);
    const row = page.getByRole("row").filter({ hasText: "Französisch" });
    await expect(row.getByText("2 offen")).toHaveCount(1);
    await row.getByRole("link", { name: "Band: Französisch 7 Test" }).click();

    // Band-Seite: Mitglied, Soll/verplant; herausnehmen; löschen
    await expect(page.getByRole("heading", { name: "Band bearbeiten · Französisch 7 Test" })).toBeVisible();
    const members = page.getByRole("region", { name: "Lehraufträge im Band" });
    const memberLink = members.getByRole("link", { name: "Klasse 7b · Französisch · BRA" });
    await expect(memberLink).toBeVisible();
    const assignmentUrl = (await memberLink.getAttribute("href"))!;
    await members.getByRole("button", { name: "Klasse 7b · Französisch · BRA aus dem Band nehmen" }).click();
    await expect(page.getByText(/Noch keine – unten einen Lehrauftrag aufnehmen/)).toBeVisible();
    await page.getByRole("button", { name: "Band löschen" }).click();
    await expect(page.getByRole("link", { name: "Französisch 7 Test" })).toHaveCount(0);

    // aufräumen: Lehrauftrag löschen (die 7b hat schon einen Französisch-Lehrauftrag aus der Demo)
    await page.goto(assignmentUrl);
    await expect(page.getByLabel("Band", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Lehrauftrag löschen" }).click();
    await expect(page).not.toHaveURL(/auftrag=/);
    await expect(page.getByRole("row").filter({ hasText: "Französisch" })).toHaveCount(1);
    await expect(page.getByRole("row").filter({ hasText: "Französisch" }).getByText("vollständig verplant")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("Deputat: Pflichtstunden, Ermäßigung, Saldo", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto("/planung/unterricht?ansicht=lehrkraefte");
    await expect(page.getByRole("heading", { name: "Deputatskonto je Lehrkraft" })).toBeVisible();
    // Demo: KLE hat 3 Std. Koordination → Soll 22,5 von 25,5
    const kle = page.getByRole("row").filter({ has: page.getByRole("link", { name: "KLE", exact: true }) });
    await expect(kle.getByRole("cell").nth(1)).toHaveText("22,5von 25,5");

    await page.getByRole("link", { name: "BRA", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Deputat" })).toBeVisible();
    await expect(page.getByText("Ausbildung (Mentoring) · Mentorin LAA")).toBeVisible();
    // Vorgabe 25,5 − 1 = 24,5
    await expect(page.getByText("Soll 24,5", { exact: true }).first()).toBeVisible();

    await page.getByLabel("Pflichtstunden").fill("20,3");
    await page.getByRole("button", { name: "Pflichtstunden speichern" }).click();
    await expect(page.getByText("0 bis 40 Stunden in halben Schritten")).toBeVisible();
    await page.getByLabel("Pflichtstunden").fill("20,5");
    await page.getByRole("button", { name: "Pflichtstunden speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
    await expect(page.getByText("Soll 19,5", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel("Pflichtstunden")).toHaveValue("20,5");

    await page.getByLabel("Grund").selectOption({ label: "Klassenleitung (Anrechnung)" });
    await page.getByLabel("Stunden", { exact: true }).fill("1");
    await page.getByRole("button", { name: "Hinzufügen" }).click();
    await expect(page.getByText("Soll 18,5", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel("Stunden", { exact: true })).toHaveValue("");
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-deputat.png", fullPage: true });

    await page.getByRole("button", { name: "Klassenleitung entfernen" }).click();
    await expect(page.getByRole("button", { name: "Klassenleitung entfernen" })).toHaveCount(0);
    await page.getByLabel("Pflichtstunden").fill("");
    await page.getByRole("button", { name: "Pflichtstunden speichern" }).click();
    await expect(page.getByText("Soll 24,5", { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Diagnose: Prüfungen, Filter, Links; Plan-Hinweise in der Pflege", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto("/planung/unterricht");
    await page.getByRole("link", { name: "Diagnose", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Diagnose", level: 2 })).toBeVisible();
    const checks = page.getByRole("navigation", { name: "Prüfungen" });
    await expect(checks.getByRole("link", { name: /Offene Stunden/ }).getByText("in Ordnung")).toBeVisible();

    // Filter Räume: Kunstraum ist für die 7b zu klein
    await checks.getByRole("link", { name: /Raum ungeeignet/ }).click();
    await expect(page).toHaveURL(/kategorie=room/);
    const k7b = page.getByRole("article", { name: "Klasse 7b" });
    await expect(k7b.getByText(/Kunst in Raum KU1: \d+ Personen, Kapazität 26/)).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: "Hohlstunde" })).toHaveCount(0);
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-diagnose.png", fullPage: true });

    // Deputat: Teilzeitkraft über Soll → Link aufs Konto
    await checks.getByRole("link", { name: /Deputat/ }).click();
    const wag = page.getByRole("article", { name: "WAG" });
    await expect(wag.getByText(/über Soll/)).toBeVisible();
    await wag.getByRole("link", { name: "WAG" }).click();
    await expect(page.getByRole("heading", { name: "WAG · Sophie Wagner" })).toBeVisible();

    // Pflege-Seite der 7b zeigt die Plan-Hinweise der Klasse
    await page.goto("/planung/stundenplan?gruppe=g-7b");
    const diag = page.getByRole("region", { name: "Diagnose" });
    await expect(diag.getByText("Raum ungeeignet:")).toBeVisible();
    await diag.getByRole("link", { name: "Diagnose der ganzen Schule" }).click();
    await expect(page.getByRole("heading", { name: "Diagnose", level: 2 })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test("Zeitwünsche: Raster für eine Lehrkraft speichern, gesperrt bleibt erhalten, Übersicht", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/unterricht");
  await page.getByRole("main").getByRole("link", { name: "Zeitwünsche" }).click();
  await expect(page.getByRole("heading", { name: "Zeitwünsche", level: 1 })).toBeVisible();
  await page.getByLabel("Lehrkraft").selectOption({ label: "WAG – Sophie Wagner" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  const grid = page.getByRole("form", { name: "Zeitwünsche WAG – Sophie Wagner" });
  await grid.getByLabel("Fr 7. Stunde").selectOption("x");
  await grid.getByLabel("Fr 8. Stunde").selectOption("x");
  await grid.getByLabel("Mo 1. Stunde").selectOption("-2");
  await grid.getByLabel("Di 3. Stunde").selectOption("3");
  await grid.getByRole("button", { name: "Zeitwünsche speichern" }).click();
  await expect(grid.getByRole("status")).toHaveText("Gespeichert.");
  await page.screenshot({ path: ".data/shots/e2e/zeitwuensche.png", fullPage: true });
  await page.reload();
  await expect(grid.getByLabel("Fr 7. Stunde")).toHaveValue("x");
  await expect(grid.getByLabel("Mo 1. Stunde")).toHaveValue("-2");
  await expect(page.getByRole("link", { name: /WAG – Sophie Wagner.*2 gesperrt.*4 Felder/ })).toBeVisible();
  expect(errors).toEqual([]);
});
