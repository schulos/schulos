import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("Stundenplanung · CSV-Import der Unterrichtsverteilung (SP2-06)", () => {
  test("Vorlage, Vorschau mit Zeilen-Fehlern, Beispieldatei (Windows-1252) übernehmen, wieder löschen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto("/planung/unterricht");
    await page.getByRole("link", { name: "CSV-Import" }).click();
    await expect(page.getByRole("heading", { name: "Unterrichtsverteilung importieren", level: 1 })).toBeVisible();

    // Vorlage: Kopfzeile + Beispielzeilen
    const tpl = await page.request.get("/api/stundenplan/verteilung-vorlage");
    expect(tpl.status()).toBe(200);
    expect(tpl.headers()["content-type"]).toContain("text/csv");
    expect((await tpl.text()).split("\r\n")[0]).toBe("﻿Klasse/Kurs;Fach;Stunden;Lehrkraft;Doppelstunden;Raumwunsch;Band");

    // Datei mit Fehlern: Vorschau nennt die Zeilen, Übernehmen gesperrt
    await page.getByLabel("CSV-Datei").setInputFiles({ name: "fehler.csv", mimeType: "text/csv", buffer: Buffer.from("Klasse;Fach;Stunden;Lehrkraft;Doppelstunden\n7b;F;3;BRA;2\n7z;D;4;BRA\n") });
    await page.getByRole("button", { name: "Prüfen (Vorschau)" }).click();
    await expect(page.getByText("0 neu · 0 ändern · 0 unverändert · 2 mit Fehlern")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "7z" }).getByText("Klasse/Kurs „7z“ gibt es nicht")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "7b" }).getByText("Doppelstunden: höchstens 1")).toBeVisible();
    await expect(page.getByRole("button", { name: /übernehmen/ })).toBeDisabled();
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    // Beispieldatei (Windows-1252, „Französisch“ mit Umlaut)
    const file = readFileSync(join(process.cwd(), "e2e", "fixtures", "unterrichtsverteilung.csv"));
    await page.getByLabel("CSV-Datei").setInputFiles({ name: "unterrichtsverteilung.csv", mimeType: "text/csv", buffer: file });
    await page.getByRole("button", { name: "Prüfen (Vorschau)" }).click();
    await expect(page.getByText("1 neu · 0 ändern · 0 unverändert · 0 mit Fehlern · gelesen als Windows-1252")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Französisch", exact: true })).toBeVisible();
    // SP2-12: BRA hat Französisch nicht als Lehrfach – Hinweis, aber kein Fehler
    await expect(page.getByText("BRA unterrichtet Französisch laut Stammdaten nicht")).toBeVisible();
    await page.getByRole("button", { name: "1 Lehrauftrag übernehmen" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Übernommen: 1 neuer Lehrauftrag, 0 geändert" })).toBeVisible();

    // in der Verteilung sichtbar → wieder löschen (Demo-Stand für folgende Tests)
    await page.getByRole("link", { name: "Zur Unterrichtsverteilung" }).click();
    await page.getByRole("link", { name: "Klasse 7b", exact: true }).click();
    // die Demo hat in 7b schon Französisch bei einer anderen Lehrkraft – die neue Zeile ist die mit BRA
    const row = page.getByRole("row").filter({ hasText: "Französisch" }).filter({ has: page.getByRole("cell", { name: "BRA" }) });
    await expect(row.getByText("1× Doppelstunde")).toBeVisible();
    await row.getByRole("link", { name: "Französisch" }).click();
    await expect(page.getByLabel("Wochenstunden")).toHaveValue("3");
    await page.getByRole("button", { name: "Lehrauftrag löschen" }).click();
    await expect(page).not.toHaveURL(/auftrag=/);
    await expect(row).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("ohne Recht stundenplan.manage: Seite 404, Vorlage 404", async ({ page }) => {
    await login(page, "jana.brandt");
    const res = await page.goto("/planung/unterricht/import");
    expect(res?.status()).toBe(404);
    expect((await page.request.get("/api/stundenplan/verteilung-vorlage")).status()).toBe(404);
  });
});
