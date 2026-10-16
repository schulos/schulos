import { expect, test } from "@playwright/test";
import { createOpenVerfahren } from "./anmeldung-helpers";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test("P4-34b: Mutter mit Konto meldet ein weiteres Kind an – vorbelegt, ohne Mailbestätigung", async ({ page }) => {
  const id = await createOpenVerfahren(page, "E2E Konto Klasse 5", "2030-03-05");
  const errors = collectErrors(page);
  await login(page, "daniela.schaefer");
  await page.getByRole("link", { name: "Schulanmeldung", exact: true }).first().click();
  await expect(page).toHaveURL("/schulanmeldung");
  await page.getByRole("article", { name: "E2E Konto Klasse 5" }).getByRole("link", { name: "Kind anmelden" }).click();
  await expect(page).toHaveURL(`/schulanmeldung/${id}`);

  const form = page.getByRole("form", { name: "Anmeldung" });
  await form.getByLabel("Vorname", { exact: true }).fill("Jonas");
  await form.getByLabel("Nachname", { exact: true }).fill("Schäfer");
  await form.getByLabel("Geburtsdatum", { exact: true }).fill("2015-06-20");
  await form.getByLabel("Grundschule", { exact: true }).fill("GS Am Park");
  // Geschwisterkind aus dem Konto vorbelegt
  await expect(form.getByLabel("Name und Klasse des Geschwisterkinds (optional)")).toHaveValue(/Lea Schäfer, Klasse 7b/);
  await form.getByRole("button", { name: "Weiter" }).click();
  await expect(form.getByLabel("Name (Elternteil)")).toHaveValue("Daniela Schäfer");
  await form.getByLabel("E-Mail-Adresse", { exact: true }).fill("daniela.e2e@example.org");
  await form.getByLabel("Straße und Hausnummer").fill("Lindenweg 5");
  await form.getByLabel("Postleitzahl").fill("12345");
  await form.getByLabel("Ort", { exact: true }).fill("Musterstadt");
  await form.getByRole("button", { name: "Weiter" }).click();
  await form.getByRole("radio", { name: /14:30–15:00/ }).first().check();
  await form.getByRole("button", { name: "Weiter" }).click();
  await form.getByLabel("Ich habe die Datenschutzhinweise gelesen.").check();
  await form.getByRole("button", { name: "Anmeldung absenden" }).click();

  await expect(page).toHaveURL(/\/schulanmeldung\/antrag\/[^/?]+\?neu=1$/);
  await expect(page.getByRole("status").filter({ hasText: "Anmeldung ist eingegangen" })).toBeVisible();
  await expect(page.getByText("Termin vereinbart")).toBeVisible();
  await expect(page.getByTestId("termin")).toContainText("14:30–15:00");
  const antrag = new URL(page.url()).pathname;
  await page.goto("/schulanmeldung");
  await expect(page.getByRole("article", { name: "Meine Anmeldungen" })).toContainText("Jonas · E2E Konto Klasse 5");

  expect(errors).toEqual([]);

  // fremde Konten: Schülerin hat keine Schulanmeldung, andere sehen den Antrag nicht
  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  expect((await page.goto("/schulanmeldung"))?.status()).toBe(404);
  expect((await page.goto(antrag))?.status()).toBe(404);
});
