import { expect, test } from "@playwright/test";
import { collectErrors, login, loginWithStartPassword } from "./helpers";

// Eigene Schülerin anlegen statt Seed-Konten zu ändern – andere Specs rechnen mit den Eltern der Klasse 7b.
test("Q5-05: Sekretariat kennzeichnet als eigenständig, die Person willigt selbst ein, Eltern weiter zu informieren", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/benutzer/neu");
  await page.getByLabel("Vorname").fill("Jola");
  await page.getByLabel("Nachname").fill("Volljaehrig");
  await page.getByLabel("Rolle").selectOption("schueler");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Benutzer angelegt")).toBeVisible();
  const username = (await page.getByTestId("cred-username").textContent())!;
  const password = (await page.getByTestId("cred-password").textContent())!;
  await page.goto("/verwaltung/benutzer?q=volljaehrig");
  await page.getByRole("link", { name: /Volljaehrig, Jola/ }).click();

  const card = page.getByRole("article", { name: "Eigenständig (volljährig)" });
  await expect(card).toContainText("minderjährig");
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Als eigenständig kennzeichnen" }).click();
  await expect(card).toContainText("Eltern sehen nichts");
  await expect(card.getByRole("button", { name: "Kennzeichen entfernen" })).toBeVisible();

  // die Person selbst: Hinweis per Gong, Einwilligung unter „Mein Konto“
  await page.context().clearCookies();
  await loginWithStartPassword(page, username, password);
  await page.getByRole("button", { name: /Profilmenü öffnen/ }).click();
  await page.getByRole("menuitem", { name: "Eltern informieren" }).click();
  await expect(page).toHaveURL("/konto/eltern");
  await expect(page.getByRole("heading", { name: "Eltern sehen nichts" })).toBeVisible();
  await page.getByRole("button", { name: "Eltern weiter informieren" }).click();
  await expect(page.getByRole("status")).toHaveText("Deine Eltern werden weiter informiert.");
  await expect(page.getByRole("heading", { name: /Eltern werden informiert \(seit/ })).toBeVisible();
  await page.getByRole("button", { name: "Einwilligung widerrufen" }).click();
  await expect(page.getByRole("status")).toHaveText("Deine Eltern sehen deine Daten nicht mehr.");

  // DS-19: eigenständige Schüler:innen melden Abwesenheiten selbst
  await page.goto("/abwesenheiten");
  await expect(page.getByRole("heading", { name: "Abwesenheit melden" })).toBeVisible();
  await page.getByLabel("krank").check();
  await page.getByRole("button", { name: "Abwesenheit melden" }).click();
  await expect(page.getByRole("status")).toContainText("deine Klassenleitung ist benachrichtigt");
  await expect(page.locator("section", { has: page.getByRole("heading", { name: "Meine Meldungen" }) })).toContainText("gemeldet");
  await expect(page.getByRole("link", { name: "Beurlaubung beantragen" })).toBeVisible();

  // Schüler:innen ohne Kennzeichen: Seite gibt es nicht
  await page.context().clearCookies();
  await login(page, "lea.schaefer");
  const res = await page.goto("/konto/eltern");
  expect(res?.status()).toBe(404);
  expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
});
