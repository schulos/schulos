import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP2-10: Drucke und CSV der Stundenplanung (Gesamtübersicht, Unterrichtsverteilung, Aufsichtsplan, Statistik).
test("SP2-10: Planung druckt die Gesamtübersicht (A4 quer) und lädt die Unterrichtsverteilung als CSV; Lehrkraft ohne Planungsrecht bekommt 404", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // Einstieg aus dem Reiter, Druckseite
  await page.goto("/planung/stundenplan");
  await page.getByText("Drucken/CSV").click();
  await page.getByRole("link", { name: "Gesamtübersicht Klassen drucken" }).click();
  await expect(page).toHaveURL(/\/druck\/stundenplan\/uebersicht\?art=gesamt-klassen/);
  await expect(page.getByRole("heading", { name: "Gesamtübersicht Klassen", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: /Gesamtübersicht Klassen/ });
  await expect(table.getByRole("row", { name: /Klasse 7b/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Mo 1" })).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/planung-druck-gesamt.png", fullPage: true });

  // CSV aus dem Reiter Unterrichtsverteilung
  await page.goto("/planung/unterricht");
  await page.getByText("Drucken/CSV").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Unterrichtsverteilung als CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^unterrichtsverteilung-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await download.createReadStream().then(async (s) => {
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  });
  expect(csv.startsWith("﻿Klasse/Kurs;Fach;Stunden;Lehrkraft;Doppelstunden;Raumwunsch;Band\r\n")).toBe(true);
  expect(csv.split("\r\n").length).toBeGreaterThan(5);

  expect(errors).toEqual([]);

  // Lehrkraft ohne Planungsrecht: Gesamtübersicht ja, Verteilung/Deputate 404
  const ctx = await browser.newContext();
  const lk = await ctx.newPage();
  await login(lk, "jana.brandt");
  expect((await lk.request.get("/api/stundenplan/export/gesamt-lehrkraefte")).status()).toBe(200);
  expect((await lk.request.get("/api/stundenplan/export/verteilung")).status()).toBe(404);
  expect((await lk.request.get("/api/stundenplan/export/deputate")).status()).toBe(404);
  expect((await lk.goto("/druck/stundenplan/uebersicht?art=aufsichten"))!.status()).toBe(404);
  await ctx.close();
});
