import { expect, test } from "@playwright/test";
import { createOpenVerfahren, fillAnmeldung, linkFromDevMail } from "./anmeldung-helpers";
import { collectErrors } from "./helpers";

test("P4-34: Eltern melden ohne Konto an, bestätigen per Link aus der Mail und sehen den Vorgang", async ({ page }) => {
  const id = await createOpenVerfahren(page, "E2E Öffentlich Klasse 5", "2030-03-04");
  const errors = collectErrors(page);

  // ohne Anmeldung: Übersicht und Formular (mehrschrittig)
  await page.goto("/anmeldung");
  await expect(page).toHaveURL("/anmeldung");
  const card = page.getByRole("article", { name: "E2E Öffentlich Klasse 5" });
  await card.getByRole("link", { name: "Zur Anmeldung" }).click();
  await expect(page.getByRole("heading", { name: "E2E Öffentlich Klasse 5" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Unterlagen" })).toContainText("Anmeldeschein");

  // Fehler im Browser: Pflichtfeld leer → bleibt im ersten Schritt
  const form = page.getByRole("form", { name: "Anmeldung" });
  await form.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { name: "Angaben zum Kind" })).toBeVisible();

  await fillAnmeldung(page, id, { first: "Mila", last: "Beispiel", email: "mila.e2e@example.org", time: "14:00–14:30" }, { ip: "198.51.100.10", hints: "<b>kommt mit dem Bus</b>" });

  // Bestätigungslink aus /dev/mail; Mail nennt keine Namen
  const confirmPath = await linkFromDevMail(page, "mila.e2e@example.org", "/anmeldung/bestaetigen/");
  expect(confirmPath).toMatch(/^\/anmeldung\/bestaetigen\/[A-Za-z0-9_-]{43}$/);
  const res = await page.goto(confirmPath);
  expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.getByRole("heading", { name: "E2E Öffentlich Klasse 5" })).toBeVisible();
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page).toHaveURL(/\/anmeldung\/vorgang\/[A-Za-z0-9_-]{43}\?bestaetigt=1$/);
  await expect(page.getByRole("status")).toContainText("Ihre Anmeldung ist bestätigt");
  await expect(page.getByTestId("vorgangsnummer")).toHaveText(/^A-2026-\d{4}$/);
  await expect(page.getByTestId("termin")).toContainText("14:00–14:30");
  await expect(page.getByText("Termin vereinbart")).toBeVisible();
  // keine Namen auf der Vorgangsseite
  await expect(page.getByText("Mila")).toHaveCount(0);
  const vorgang = new URL(page.url()).pathname;
  const ics = await page.request.get(`${vorgang}/termin.ics`);
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toContain("text/calendar");
  expect(await ics.text()).toContain("BEGIN:VEVENT");

  // derselbe Bestätigungslink gilt nur einmal; erfundene Links verraten nichts
  await page.goto(confirmPath);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("ungültig oder abgelaufen");
  await page.goto(`/anmeldung/vorgang/${"x".repeat(43)}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("ungültig oder abgelaufen");
  expect(errors).toEqual([]);
});

test("P4-34: Nicht veröffentlichte oder unbekannte Verfahren gibt es öffentlich nicht; Verwaltung bleibt zu", async ({ page }) => {
  expect((await page.goto("/anmeldung/gibts-nicht"))?.status()).toBe(404);
  await page.goto("/verwaltung/anmeldung");
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/anmeldungen");
  await expect(page).toHaveURL(/\/login/);
});

test("P4-35: Eltern ändern über den Vorgangslink den Termin und ziehen die Anmeldung zurück", async ({ page }) => {
  const id = await createOpenVerfahren(page, "E2E Vorgang Klasse 5", "2030-03-06", 1);
  const errors = collectErrors(page);
  await fillAnmeldung(page, id, { first: "Paul", last: "Beispiel", email: "paul.e2e@example.org", time: "14:00–14:30" }, { ip: "198.51.100.20" });
  const confirmPath = await linkFromDevMail(page, "paul.e2e@example.org", "/anmeldung/bestaetigen/");
  await page.goto(confirmPath);
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page).toHaveURL(/\/anmeldung\/vorgang\//);
  // derselbe Link steht in der Eingangsmail
  const vorgang = await linkFromDevMail(page, "paul.e2e@example.org", "/anmeldung/vorgang/");
  await page.goto(vorgang.replace(/\/termin\.ics$/, ""));
  await expect(page.getByTestId("termin")).toContainText("14:00–14:30");

  const change = page.getByRole("form", { name: "Termin ändern" });
  await change.getByLabel("Neuer Termin").selectOption({ index: 1 });
  await change.getByRole("button", { name: "Termin ändern" }).click();
  await expect(change.getByRole("status")).toContainText("Der Termin ist geändert");
  await expect(page.getByTestId("termin")).toContainText("14:30–15:00");

  const withdraw = page.getByRole("form", { name: "Anmeldung zurückziehen" });
  await withdraw.getByLabel("Ja, ich ziehe die Anmeldung zurück.").check();
  await withdraw.getByRole("button", { name: "Anmeldung zurückziehen" }).click();
  await expect(page.getByText("Zurückgezogen", { exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Termin ändern" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
