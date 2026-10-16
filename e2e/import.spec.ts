import { expect, test } from "@playwright/test";
import { collectErrors, login, loginWithStartPassword } from "./helpers";

test("CSV-Import: Vorschau mit Fehlern, Import, Login mit Startpasswort", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/import");
  await page.getByLabel("CSV-Inhalt").fill("Vorname;Nachname;Klasse\nEmma;Importtest;5a\nPaul;Importtest;5z\nIda;;5a");
  await page.getByRole("button", { name: "Vorschau" }).click();
  await expect(page.getByText("1 bereit")).toBeVisible();
  await expect(page.getByText("2 mit Fehler")).toBeVisible();
  await expect(page.getByText("Klasse „5z“ gibt es nicht")).toBeVisible();
  await expect(page.getByText("Zeile 4: Vorname, Nachname und Klasse sind Pflicht")).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/verwaltung-import.png", fullPage: true });

  await page.getByRole("button", { name: "1 Schüler:in importieren" }).click();
  await expect(page.getByText("1 Schüler:in angelegt")).toBeVisible();
  const row = page.getByRole("row", { name: /Emma Importtest/ });
  const password = (await row.getByRole("cell").nth(3).textContent())!;
  await expect(page.getByRole("link", { name: /Zugangsdaten herunterladen/ })).toHaveAttribute("download", "zugangsdaten.csv");
  expect(errors).toEqual([]);

  await page.context().clearCookies();
  await loginWithStartPassword(page, "emma.importtest", password);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Emma");
});
