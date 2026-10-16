import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// P4-77: Schulprofil – Export unter Verwaltung → Schule (Download, ohne Personendaten), Einspielen in die Demo-Instanz
// (die E2E-Instanz ist eine Demo). Am Ende wird das ursprüngliche Profil wieder eingespielt (Schulname für andere Specs).

async function importFile(page: Page, name: string, json: string) {
  const form = page.getByRole("form", { name: "Schulprofil einspielen" });
  await form.getByLabel("Schulprofil-Datei").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(json) });
  await form.getByRole("button", { name: "Schulprofil einspielen" }).click();
  return form;
}

test("P4-77: Schulprofil exportieren (ohne Personendaten) und in die Vorschau einspielen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "admin");
  await page.goto("/verwaltung/schule");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Schulprofil exportieren" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^schulprofil-\d{4}-\d{2}-\d{2}\.json$/);
  const original = readFileSync((await file.path())!, "utf8");
  const profile = JSON.parse(original);
  expect(profile).toMatchObject({ format: "schulos-schulprofil", version: 1, school: { name: "Gesamtschule am Lindenhof", state: "NW" } });
  for (const person of ["jana.brandt", "Jana Brandt", "lea.schaefer", "Sabine Kowalski", "@"]) expect(original).not.toContain(person);

  // geändertes Profil einspielen: Schulname und Farbe der „echten“ Schule
  profile.school.name = "Realschule am Teich";
  profile.school.color = "#7A1F5C";
  let form = await importFile(page, "teich.json", JSON.stringify(profile));
  await expect(form.getByRole("status")).toContainText("Schulprofil eingespielt");
  await page.goto("/");
  await expect(page.getByText("Realschule am Teich").first()).toBeVisible();

  // Datei mit Personendaten wird abgelehnt
  await page.goto("/verwaltung/schule");
  form = await importFile(page, "mit-personen.json", JSON.stringify({ ...profile, users: [{ name: "Lea Schäfer" }] }));
  await expect(form.getByRole("alert")).toContainText("nicht erlaubte Angabe(n): users");

  // zurück auf das ursprüngliche Profil
  form = await importFile(page, "original.json", original);
  await expect(form.getByRole("status")).toContainText("Schulprofil eingespielt");
  await page.goto("/");
  await expect(page.getByText("Gesamtschule am Lindenhof").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("P4-77: ohne Rechteverwaltung kein Schulprofil, Export-Route nur per POST mit Recht", async ({ page }) => {
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/schule");
  await expect(page.getByRole("button", { name: "Schulprofil exportieren" })).toHaveCount(0);
  const res = await page.request.post("/api/verwaltung/schulprofil", { headers: { origin: new URL(page.url()).origin } });
  expect([403, 404]).toContain(res.status());
  expect((await page.request.get("/api/verwaltung/schulprofil")).status()).toBeGreaterThanOrEqual(400);
});
