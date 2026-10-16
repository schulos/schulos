import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, loginWithStartPassword } from "./helpers";

const SHOTS = ".data/shots/e2e";

async function loginFresh(page: Page, username: string, password?: string) {
  await page.context().clearCookies();
  await login(page, username, password);
}

test.describe("Verwaltung · Benutzer", () => {
  test("Suche und Filter", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/benutzer");
    await expect(page.getByText(/^1–50 von \d{3}$/)).toBeVisible(); // Anzahl hängt von vorherigen Tests ab
    await page.screenshot({ path: `${SHOTS}/verwaltung-benutzer.png` });

    await page.getByLabel("Suche").fill("brandt");
    await page.getByRole("button", { name: "Filtern" }).click();
    await expect(page.getByRole("link", { name: /Brandt, Jana/ })).toBeVisible();

    await page.goto("/verwaltung/benutzer?klasse=7b&role=schueler");
    await expect(page.getByText("1–25 von 25")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Anlegen → Anmelden mit den angezeigten Zugangsdaten", async ({ page }) => {
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/benutzer/neu");
    await page.getByLabel("Vorname").fill("Mia");
    await page.getByLabel("Nachname").fill("Testmann");
    await page.getByLabel("Rolle").selectOption("schueler");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByText("Benutzer angelegt")).toBeVisible();
    const username = (await page.getByTestId("cred-username").textContent())!;
    const password = (await page.getByTestId("cred-password").textContent())!;
    expect(username).toBe("mia.testmann");

    // Startpasswort: zuerst eigenes Passwort – Regeln greifen, bis dahin keine Shell
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Benutzername").fill(username);
    await page.getByLabel("Passwort").fill(password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page).toHaveURL("/passwort");
    expect((await page.goto("/aufgaben"))?.url()).toMatch(/\/passwort$/);
    // auch die API-Routen (Dateien, Exporte) erst nach dem Passwortwechsel (B-55)
    expect((await page.request.post("/api/eigenexport")).status()).toBe(403);
    const form = page.getByRole("form", { name: "Passwort ändern" });
    await form.getByLabel("Bisheriges Passwort").fill(password);
    await form.getByLabel("Neues Passwort", { exact: true }).fill("Passwort2026!");
    await form.getByLabel("Neues Passwort wiederholen").fill("Passwort2026!");
    await form.getByRole("button", { name: "Passwort ändern" }).click();
    await expect(form.getByText("Zu leicht zu erraten (bekanntes Wort mit Zahlen).")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/passwort-pflicht.png` });
    await page.context().clearCookies();
    await loginWithStartPassword(page, username, password);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Mia");
  });

  test("Validierung: Kürzel schon vergeben", async ({ page }) => {
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/benutzer/neu");
    await page.getByLabel("Vorname").fill("Jan");
    await page.getByLabel("Nachname").fill("Brand");
    await page.getByLabel("Rolle").selectOption("lehrkraft");
    await page.getByLabel("Kürzel").fill("BRA");
    await page.getByLabel("Benutzername").fill("jan.brand.test");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByText("Kürzel ist vergeben")).toBeVisible();
    // Eingaben bleiben nach dem Fehler stehen (TD-02)
    await expect(page.getByLabel("Vorname")).toHaveValue("Jan");
    await expect(page.getByLabel("Nachname")).toHaveValue("Brand");
    await expect(page.getByLabel("Kürzel")).toHaveValue("BRA");
    await expect(page.getByLabel("Benutzername")).toHaveValue("jan.brand.test");
  });

  test("Sperren verhindert Anmeldung, Passwort-Reset liefert neues Passwort", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/benutzer?q=nadine.vogel");
    await page.getByRole("link", { name: /Vogel, Nadine/ }).click();
    await page.getByRole("button", { name: "Sperren" }).click();
    await expect(page.getByText("Das Konto ist gesperrt")).toBeVisible();

    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Benutzername").fill("nadine.vogel");
    await page.getByLabel("Passwort").fill("schulos");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Dieses Konto ist gesperrt.");

    await loginFresh(page, "sabine.kowalski");
    await page.goto("/verwaltung/benutzer/u-nadine.vogel");
    await page.getByRole("button", { name: "Entsperren" }).click();
    await expect(page.getByText("Das Konto ist aktiv.")).toBeVisible();
    await page.getByRole("button", { name: "Passwort zurücksetzen" }).click();
    const pw = (await page.getByTestId("cred-password").textContent())!;
    await page.screenshot({ path: `${SHOTS}/verwaltung-benutzer-detail.png` });

    await page.context().clearCookies();
    await loginWithStartPassword(page, "nadine.vogel", pw);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Nadine Vogel");
  });

  test("Lehrkräfte kommen nicht in die Benutzerverwaltung", async ({ page }) => {
    await login(page, "jana.brandt");
    expect((await page.goto("/verwaltung/benutzer"))?.status()).toBe(404);
  });
});

test("Löschkonzept listet Löschklassen und alle Module", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung");
  await page.getByRole("link", { name: "Datenschutz", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Löschkonzept" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Löschklassen" })).toBeVisible();
  for (const name of ["Grundsystem", "Messenger", "Aufgaben", "Dateien"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("row", { name: /Schulkommunikation.*chat_messages/ })).toContainText("LK-1J");
  await page.screenshot({ path: ".data/shots/e2e/verwaltung-loeschkonzept.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("Schuldaten: Land und Schulform bestimmen die Vorschau der Jahrgänge", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung");
  await page.getByRole("navigation", { name: "Verwaltung" }).getByRole("link", { name: "Schule", exact: true }).click();
  const preview = page.getByRole("complementary", { name: "Vorschau" });
  await expect(preview).toContainText("5 · 6 · 7 · 8 · 9 · 10 · EF · Q1 · Q2");
  await expect(preview).toContainText("E (Erweiterungskurs)");

  await page.getByLabel("Bundesland").selectOption("HH");
  await page.getByLabel("Schulform").selectOption({ label: "Stadtteilschule" });
  await page.getByLabel("mit gymnasialer Oberstufe").uncheck();
  await expect(preview).toContainText("5 · 6 · 7 · 8 · 9 · 10");
  await expect(preview).not.toContainText("11");
  await page.getByLabel("Bundesland").selectOption("BE");
  await page.getByLabel("Schulform").selectOption({ label: "Gymnasium" });
  await page.getByLabel("Abitur nach").selectOption("g8");
  await expect(preview).toContainText("7 · 8 · 9 · 10 · 11 · 12");
  await page.screenshot({ path: ".data/shots/e2e/verwaltung-schule.png", fullPage: true });

  // zurück auf die Demo-Schule und speichern
  await page.reload();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Gespeichert.");
  expect(errors).toEqual([]);
});
