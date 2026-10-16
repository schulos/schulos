import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// Die vollständige Kopplung mit einem laufenden Backupserver prüft apps/backup/e2e (npm run e2e:backup).

test("Verwaltung → Backup: nur mit Systemrecht; ohne Kopplung rote Warnung, Eingaben werden geprüft", async ({ page }) => {
  await login(page, "sabine.kowalski");
  expect((await page.goto("/verwaltung/backup"))?.status()).toBe(404);
  await page.goto("/verwaltung");
  await expect(page.getByRole("link", { name: "Backup", exact: true })).toHaveCount(0);

  await logoutForSwitch(page);
  const errors = collectErrors(page); // ab hier – der 404 oben ist gewollt
  await login(page, "admin");
  await page.goto("/verwaltung");
  await page.getByRole("link", { name: "Backup", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Backup", level: 1 })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Keine Sicherung eingerichtet" })).toBeVisible();

  const form = page.getByRole("form", { name: "Backupserver koppeln" });
  await form.getByLabel("Adresse des Backupservers").fill("https://backup.invalid");
  await form.getByLabel("Kopplungscode").fill("1234");
  await form.getByRole("button", { name: "Koppeln" }).click();
  await expect(form.getByRole("alert")).toContainText("nicht das richtige Format");
  await expect(form.getByLabel("Adresse des Backupservers")).toHaveValue("https://backup.invalid");

  await form.getByLabel("Kopplungscode").fill("K7Q2-9MXA-4RT1");
  await form.getByRole("button", { name: "Koppeln" }).click();
  await expect(form.getByRole("alert")).toContainText("nicht erreichbar");
  expect(errors).toEqual([]);
});
