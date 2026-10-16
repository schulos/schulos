import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, loginWithStartPassword } from "./helpers";

// SEC-03: Sicherheitsschlüssel als zweiter Faktor – mit dem virtuellen Authenticator von Chromium (CDP WebAuthn), also ohne
// echten Schlüssel. Eigenes, frisch angelegtes Konto, damit andere Specs (Anmeldung nur mit Passwort) unberührt bleiben.

const NEW_PASSWORD = "Kreide Tafel Schlüssel";

async function virtualKey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "usb", hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

async function passwordOnly(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Passwort").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

test("SEC-03: Lehrkraft richtet Sicherheitsschlüssel ein, meldet sich damit an und entfernt ihn wieder", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/benutzer/neu");
  await page.getByLabel("Vorname").fill("Paula");
  await page.getByLabel("Nachname").fill("Passkey");
  await page.getByLabel("Rolle").selectOption("lehrkraft");
  await page.getByLabel("Kürzel").fill("PSK");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Benutzer angelegt")).toBeVisible();
  const username = (await page.getByTestId("cred-username").textContent())!;
  const startPassword = (await page.getByTestId("cred-password").textContent())!;

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors = collectErrors(p);
  await virtualKey(p);
  await loginWithStartPassword(p, username, startPassword, NEW_PASSWORD);

  // Benutzermenü → Zwei-Faktor-Anmeldung und Sicherheitsschlüssel
  await p.getByRole("button", { name: /Paula Passkey/ }).click();
  await p.getByRole("menuitem", { name: "Zwei-Faktor-Anmeldung und Sicherheitsschlüssel" }).click();
  const card = p.getByRole("article", { name: "Sicherheitsschlüssel" });
  await expect(card).toContainText("Noch kein Schlüssel eingerichtet.");
  const add = card.getByRole("form", { name: "Schlüssel hinzufügen" });
  await add.getByLabel("Name des Schlüssels").fill("Testschlüssel");
  await add.getByLabel("Passwort zur Bestätigung").fill("falsch!!");
  await add.getByRole("button", { name: "Schlüssel hinzufügen" }).click();
  await expect(add.getByRole("alert")).toHaveText("Das Passwort ist falsch.");
  await expect(add.getByLabel("Name des Schlüssels")).toHaveValue("Testschlüssel");
  await add.getByLabel("Passwort zur Bestätigung").fill(NEW_PASSWORD);
  await add.getByRole("button", { name: "Schlüssel hinzufügen" }).click();
  await expect(p).toHaveURL("/zwei-faktor?schluessel=1");
  await expect(p.getByRole("status")).toContainText("Sicherheitsschlüssel ist eingerichtet");
  await expect(card.getByRole("list", { name: "Eingerichtete Schlüssel" })).toContainText("Testschlüssel");
  await p.screenshot({ path: ".data/shots/e2e/passkey-eingerichtet.png", fullPage: true });

  // Anmeldung: Passwort, dann Schlüssel (kein Code-Feld – das Konto hat keine Code-App)
  await p.goto("about:blank");
  await ctx.clearCookies();
  await passwordOnly(p, username);
  await expect(p).toHaveURL("/login/zweiter-faktor?schluessel=1&code=0");
  await expect(p.getByLabel("Code aus der Authenticator-App")).toHaveCount(0);
  await p.screenshot({ path: ".data/shots/e2e/passkey-anmeldung.png" });
  await p.getByRole("button", { name: "Mit Sicherheitsschlüssel anmelden" }).click();
  await expect(p).toHaveURL("/");

  // Verwaltung sieht den Weg (ohne Details)
  await page.goto(`/verwaltung/benutzer?q=${username}`);
  await page.getByRole("link", { name: /Passkey, Paula/ }).click();
  await expect(page.getByTestId("zwei-faktor-wege")).toHaveText("1 Sicherheitsschlüssel");

  // Entfernen (freiwillig in der Demo) → 2FA aus, Anmeldung wieder nur mit Passwort
  await p.goto("/zwei-faktor");
  await card.getByRole("button", { name: "Entfernen …" }).click();
  const remove = card.getByRole("form", { name: "Schlüssel „Testschlüssel“ entfernen" });
  await remove.getByLabel("Passwort zur Bestätigung").fill(NEW_PASSWORD);
  await remove.getByRole("button", { name: "Schlüssel entfernen" }).click();
  await expect(p).toHaveURL("/zwei-faktor?entfernt=1");
  await expect(p.getByRole("status")).toContainText("Die Zwei-Faktor-Anmeldung ist damit aus.");
  await p.goto("about:blank");
  await ctx.clearCookies();
  await passwordOnly(p, username);
  await expect(p).toHaveURL("/");
  expect(errors).toEqual([]);
  await ctx.close();
});
