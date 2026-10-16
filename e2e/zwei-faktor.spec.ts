import { expect, test, type Page } from "@playwright/test";
import { totpCode } from "@schulos/server/totp-code";
import { collectErrors, DEMO_PASSWORD, login } from "./helpers";

// Die E2E-DB ist eine Demo-Instanz: dort ist 2FA freiwillig (die Pflicht prüft zwei-faktor.test.ts).
// Läuft als letztes Spec; setzt das Konto am Ende über die Verwaltung zurück.

async function passwordOnly(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Passwort").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

/** Nächster Code aus einem neuen 30-s-Fenster (ein Code gilt nur einmal). */
async function freshCode(secret: string, used: Set<string>): Promise<string> {
  for (;;) {
    const c = totpCode(secret);
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test("Zwei-Faktor: einrichten, Anmeldung mit Code und mit Wiederherstellungscode, Zurücksetzen durch die Verwaltung", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  const used = new Set<string>();

  await login(page, "sabine.kowalski");
  await page.getByRole("button", { name: /Sabine Kowalski/ }).click();
  await page.getByRole("menuitem", { name: "Zwei-Faktor-Anmeldung" }).click();
  await expect(page.getByRole("heading", { name: "Zwei-Faktor-Anmeldung", level: 1 })).toBeVisible();
  await expect(page.getByText(/in dieser Demo ist sie freiwillig/)).toBeVisible();

  const startForm = page.getByRole("form", { name: "Einrichtung starten" });
  await startForm.getByLabel("Passwort zur Bestätigung").fill("falsch!!");
  await startForm.getByRole("button", { name: "Einrichtung starten" }).click();
  await expect(startForm.getByRole("alert")).toHaveText("Das Passwort ist falsch.");
  await startForm.getByLabel("Passwort zur Bestätigung").fill(DEMO_PASSWORD);
  await startForm.getByRole("button", { name: "Einrichtung starten" }).click();

  await expect(page.getByRole("img", { name: "QR-Code für die Authenticator-App" })).toBeVisible();
  const secret = (await page.getByLabel("Geheimnis").textContent())!.replace(/\s/g, "");
  const codes = await page.getByRole("list", { name: "Wiederherstellungscodes" }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  await page.screenshot({ path: ".data/shots/e2e/zwei-faktor-einrichten.png", fullPage: true });

  const confirm = page.getByRole("form", { name: "Code bestätigen" });
  await confirm.getByLabel("2. Code aus der App").fill("000000");
  await confirm.getByRole("button", { name: "Bestätigen und einschalten" }).click();
  await expect(confirm.getByRole("alert")).toHaveText("Der Code ist falsch oder abgelaufen.");
  await confirm.getByLabel("2. Code aus der App").fill(await freshCode(secret, used));
  await confirm.getByRole("button", { name: "Bestätigen und einschalten" }).click();
  await expect(page).toHaveURL("/zwei-faktor?eingerichtet=1");
  await expect(page.getByRole("status")).toContainText("ist eingerichtet");

  // Anmeldung mit Code
  await page.context().clearCookies();
  await passwordOnly(page, "sabine.kowalski");
  await expect(page).toHaveURL("/login/zweiter-faktor");
  await page.getByLabel("Code aus der Authenticator-App").fill("123456");
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page.getByRole("form", { name: "Zweiter Faktor" }).getByRole("alert")).toHaveText("Der Code ist falsch oder abgelaufen.");
  await page.screenshot({ path: ".data/shots/e2e/zwei-faktor-anmeldung.png" });
  await page.getByLabel("Code aus der Authenticator-App").fill(await freshCode(secret, used));
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page).toHaveURL("/");

  // Anmeldung mit Wiederherstellungscode
  await page.context().clearCookies();
  await passwordOnly(page, "sabine.kowalski");
  await page.getByRole("button", { name: /Wiederherstellungscode verwenden/ }).click();
  await page.getByLabel("Wiederherstellungscode").fill(codes[0]!);
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page).toHaveURL("/");

  // Admin setzt zurück → Anmeldung wieder nur mit Passwort
  await page.context().clearCookies();
  await login(page, "admin");
  await page.goto("/verwaltung/benutzer/u-sabine.kowalski");
  const card = page.getByRole("article", { name: "Zwei-Faktor-Anmeldung" });
  await expect(card).toContainText("eingeschaltet");
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Zwei-Faktor zurücksetzen" }).click();
  await expect(card.getByRole("status")).toHaveText("Zurückgesetzt.");
  await expect(card).toContainText("aus");
  await page.goto("/verwaltung/protokoll");
  await expect(page.getByText("Zwei-Faktor-Anmeldung zurückgesetzt").first()).toBeVisible();

  await page.context().clearCookies();
  await login(page, "sabine.kowalski");
  expect(errors).toEqual([]);
});
