import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SEC-04: Rechteausweitung, Weiterleitung nach der Anmeldung, Selbständerung über /api/auth

test.describe("Rechteausweitung (SEC-04)", () => {
  test("Sekretariat: keine Admin-Rolle anbietbar, eigene Rolle gesperrt – auch ein manipuliertes Formular scheitert", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");

    await page.goto("/verwaltung/benutzer/neu");
    const options = await page.getByLabel("Rolle").locator("option").allTextContents();
    expect(options).toContain("Lehrkraft");
    expect(options).not.toContain("Administration");

    await page.goto("/verwaltung/benutzer/u-sabine.kowalski");
    const role = page.getByLabel("Rolle");
    await expect(role).toBeDisabled();
    await expect(page.getByText("Deine eigene Rolle kann nur jemand anderes ändern")).toBeVisible();
    // Formular von Hand umbauen (wie mit den Browser-Werkzeugen): der Server lehnt trotzdem ab
    await page.locator('input[type="hidden"][name="role"]').evaluate((el: HTMLInputElement) => (el.value = "admin"));
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(page.getByText("Deine eigene Rolle kann nur jemand anderes ändern").first()).toBeVisible();
    await expect(page.locator("form").getByRole("alert")).toContainText("Bitte die markierten Felder prüfen.");
    await page.reload();
    await expect(page.getByText("Verwaltung · sabine.kowalski")).toBeVisible();

    // Admin-Konto: nur Hinweis, keine Knöpfe für Passwort, Sperre oder 2FA
    await page.goto("/verwaltung/benutzer/u-admin");
    await expect(page.getByText("Admin-Konten kann nur ein Admin verwalten.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Passwort zurücksetzen" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sperren" })).toHaveCount(0);
    await expect(page.getByLabel("Rolle")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Sekretariat kann sich nicht selbst in die Schulleitung (Gruppe mit Verwaltungsrechten) aufnehmen", async ({ page }) => {
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/gruppen/g-schulleitung");
    await page.getByLabel("Mitglied hinzufügen").fill("sabine.kowalski");
    await page.getByRole("button", { name: "Sabine Kowalski hinzufügen" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Diese Gruppe hat eigene Rechte. Dich selbst kann hier nur jemand anderes aufnehmen." }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: /Kowalski.*entfernen/ })).toHaveCount(0);
  });
});

test("Anmeldung: Weiterleitung nur auf Seiten von SchulOS (`/\\fremd` landet auf der Startseite)", async ({ page }) => {
  await page.goto("/login?next=%2F%5Cevil.example%2Flogin");
  await page.getByLabel("Benutzername").fill("jana.brandt");
  await page.getByLabel("Passwort").fill("schulos");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL("/");

  // gültiges Ziel bleibt erhalten
  await page.goto("about:blank");
  await page.context().clearCookies();
  await page.goto("/login?next=%2Fkalender");
  await page.getByLabel("Benutzername").fill("jana.brandt");
  await page.getByLabel("Passwort").fill("schulos");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL("/kalender");
});

test("Name und Benutzername lassen sich nicht über /api/auth ändern, E-Mail-Anmeldung ist aus", async ({ page }) => {
  await login(page, "lea.schaefer");
  const res = await page.request.post("/api/auth/update-user", { data: { name: "Petra Lindner (Schulleitung)" } });
  expect(res.status()).toBe(404);
  expect((await page.request.post("/api/auth/sign-in/email", { data: { email: "jana.brandt@schulos.local", password: "schulos" } })).status()).toBe(404);
  await page.goto("/");
  await expect(page.getByText("Petra Lindner (Schulleitung)")).toHaveCount(0);
});
