import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test("P4-33: Sekretariat legt Anmeldeverfahren an, plant Termine, veröffentlicht und schließt", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung");
  await page.getByRole("link", { name: "Schulanmeldung", exact: true }).click();
  await expect(page).toHaveURL("/verwaltung/anmeldung");
  await page.getByRole("link", { name: "Neues Verfahren" }).click();

  const form = page.getByRole("form", { name: "Verfahren" });
  // Fehler: Eingaben bleiben erhalten
  await form.getByLabel("Name", { exact: true }).fill("x");
  await form.getByLabel("Plätze", { exact: true }).fill("90");
  await form.getByRole("button", { name: "Anlegen und Termine planen" }).click();
  await expect(form.getByRole("alert")).toContainText("mind. 3 Zeichen");
  await expect(form.getByLabel("Plätze", { exact: true })).toHaveValue("90");

  await form.getByLabel("Name", { exact: true }).fill("E2E Anmeldung Klasse 5");
  await form.getByRole("button", { name: "Anlegen und Termine planen" }).click();
  await expect(page).toHaveURL(/\/verwaltung\/anmeldung\/[^/]+\/termine$/);

  // Termine erzeugen: 2 Tage × 2 Gespräche à 30 min, je 2 parallel
  const gen = page.getByRole("form", { name: "Termine erzeugen" });
  await gen.getByLabel("Tage", { exact: true }).fill("2030-02-10, 2030-02-11");
  await gen.getByLabel("Zeitfenster", { exact: true }).fill("14:00-15:00");
  await gen.getByLabel("Dauer je Gespräch (Minuten)").fill("30");
  await gen.getByLabel("Parallele Gespräche").fill("2");
  await gen.getByRole("button", { name: "Termine erzeugen" }).click();
  await expect(gen.getByRole("status")).toContainText("4 Termine angelegt");
  const termine = page.getByRole("region", { name: "Termine" });
  await expect(termine.getByTestId("termine-summe")).toHaveText("4 Termine · 8 Plätze · 0 gebucht");
  // noch einmal: doppelte Startzeiten werden übersprungen
  await gen.getByLabel("Tage", { exact: true }).fill("2030-02-10");
  await gen.getByRole("button", { name: "Termine erzeugen" }).click();
  await expect(gen.getByRole("status")).toContainText("0 Termine angelegt, 2 schon vorhanden");
  await page.getByRole("button", { name: "Termin 2030-02-11 14:30–15:00 löschen" }).click();
  await expect(termine.getByTestId("termine-summe")).toHaveText("3 Termine · 6 Plätze · 0 gebucht");

  // Übersicht: veröffentlichen → Art und Ziel stehen fest
  await page.getByRole("navigation", { name: "Verfahren" }).getByRole("link", { name: "Übersicht" }).click();
  await expect(page.getByRole("heading", { name: "E2E Anmeldung Klasse 5" })).toBeVisible();
  await expect(page.getByText("Entwurf", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Veröffentlichen" }).click();
  await expect(page.getByText("Veröffentlicht", { exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Verfahren" }).getByLabel("Art", { exact: true })).toBeDisabled();
  const edit = page.getByRole("form", { name: "Verfahren" });
  await edit.getByLabel("Hinweistext für Eltern").fill("Bitte den Anmeldeschein mitbringen.\nWir freuen uns auf Sie.");
  await edit.getByRole("button", { name: "Speichern" }).click();
  await expect(edit.getByRole("status")).toHaveText("Gespeichert.");

  // Vorschau als Elternteil
  await page.getByRole("link", { name: "Vorschau für Eltern" }).click();
  const preview = page.getByRole("article", { name: "Vorschau" });
  await expect(preview).toContainText("Wir freuen uns auf Sie.");
  await expect(preview.getByRole("article", { name: "Unterlagen" })).toContainText("Anmeldeschein der Grundschule");
  await expect(preview.getByRole("article", { name: "Freie Termine" })).toContainText("14:00 · 14:30");

  // Liste und Schließen
  await page.getByRole("navigation", { name: "Verfahren" }).getByRole("link", { name: "Übersicht" }).click();
  await page.getByRole("button", { name: "Anmeldung schließen" }).click();
  await expect(page.getByText("Geschlossen", { exact: true })).toBeVisible();
  await page.goto("/verwaltung/anmeldung");
  const row = page.getByRole("row").filter({ hasText: "E2E Anmeldung Klasse 5" });
  await expect(row).toContainText("Geschlossen");
  await expect(row).toContainText("Übergang in die weiterführende Schule");
  expect(errors).toEqual([]);
});

test("P4-33: Schulleitung liest ohne Anlegen, Lehrkräfte sehen die Schulanmeldung nicht", async ({ page }) => {
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/anmeldung");
  await expect(page.getByRole("heading", { name: "Schulanmeldung", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Neues Verfahren" })).toHaveCount(0);
  const res = await page.goto("/verwaltung/anmeldung/neu");
  expect(res?.status()).toBe(404);

  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  expect((await page.goto("/verwaltung/anmeldung"))?.status()).toBe(404);
});

test("Q5-22: Impressum als Pflichtfelder in Verwaltung → Schule, öffentlich ohne Anmeldung", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "admin");
  await page.goto("/verwaltung/schule");
  const form = page.getByRole("form", { name: "Impressum" });
  await expect(form.getByTestId("impressum-complete")).toBeVisible();
  // Pflichtfeld leeren → Hinweis hier und in der Schulanmeldung
  await form.getByLabel("Telefon").fill("");
  await form.getByRole("button", { name: "Impressum speichern" }).click();
  await expect(form.getByRole("status")).toHaveText("Gespeichert.");
  await page.reload();
  await expect(page.getByRole("form", { name: "Impressum" }).getByTestId("impressum-missing")).toContainText("es fehlt: Telefon");
  await page.goto("/verwaltung/anmeldung");
  await expect(page.getByTestId("anmeldung-impressum-hinweis")).toContainText("fehlt: Telefon");

  await page.goto("/verwaltung/schule");
  const again = page.getByRole("form", { name: "Impressum" });
  await again.getByLabel("Telefon").fill("0123 456789-0");
  await again.getByLabel("Weitere Angaben").fill("Inhaltlich verantwortlich: Petra Lindner");
  await again.getByRole("button", { name: "Impressum speichern" }).click();
  await expect(again.getByRole("status")).toHaveText("Gespeichert.");
  await page.goto("/verwaltung/anmeldung");
  await expect(page.getByTestId("anmeldung-impressum-hinweis")).toHaveCount(0);

  await logoutForSwitch(page);
  await page.goto("/impressum");
  await expect(page).toHaveURL("/impressum");
  await expect(page.getByRole("heading", { name: "Impressum" })).toBeVisible();
  const text = page.getByTestId("impressum-text");
  await expect(text).toContainText("Lindenweg 1");
  await expect(text).toContainText("12345 Musterstadt");
  await expect(text).toContainText("Petra Lindner, Schulleiterin");
  await expect(text).toContainText("Inhaltlich verantwortlich: Petra Lindner");
  expect(errors).toEqual([]);
});
