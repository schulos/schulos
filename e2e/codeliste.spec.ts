import { expect, test, type Browser } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SEC-01/SEC-02: Schülerin ohne Handy bekommt im Sekretariat eine gedruckte Code-Liste. Von „außen“ (Client-Adresse außerhalb
// des Schulnetzes – hier per X-Forwarded-For, wie sie Caddy setzt) fragt SchulOS nach dem Passwort nach einem Code; im
// Schulnetz nicht. Jeder Code gilt nur einmal. Die E2E-DB ist eine Demo: Pflicht gibt es dort nicht – wer aber eine Liste hat,
// braucht von außen den Code (wie Konten mit 2FA im Notenbuch).

const OUTSIDE = { "x-forwarded-for": "203.0.113.50" };
const NEW_PASSWORD = "Kreide Tafel 2026";

async function outsideLogin(browser: Browser, username: string, password: string) {
  const ctx = await browser.newContext({ extraHTTPHeaders: OUTSIDE });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  return { ctx, page };
}

test("SEC-02: Sekretariat druckt Code-Liste, Schülerin meldet sich von außen mit Code an", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/benutzer/neu");
  await page.getByLabel("Vorname").fill("Carla");
  await page.getByLabel("Nachname").fill("Codeliste");
  await page.getByLabel("Rolle").selectOption("schueler");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Benutzer angelegt")).toBeVisible();
  const username = (await page.getByTestId("cred-username").textContent())!;
  const startPassword = (await page.getByTestId("cred-password").textContent())!;

  await page.goto(`/verwaltung/benutzer?q=${username}`);
  await page.getByRole("link", { name: /Codeliste, Carla/ }).click();
  const card = page.getByRole("article", { name: "Zwei-Faktor-Anmeldung" });
  await expect(card).toContainText("Pflicht nur bei Anmeldung von außerhalb des Schulnetzes");
  await card.getByRole("button", { name: "Code-Liste erzeugen" }).click();
  await expect(card.getByRole("status")).toContainText("Neue Code-Liste erzeugt");
  const codes = await card.getByRole("list", { name: "Codes der Liste" }).getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  await expect(card.getByRole("button", { name: "Drucken" })).toBeVisible();
  await page.reload();
  await expect(card.getByTestId("codeliste-status")).toContainText("noch 10 von 10 Codes");
  // nach dem Neuladen sind die Codes nicht mehr zu sehen (nur gehasht gespeichert)
  await expect(card.getByRole("list", { name: "Codes der Liste" })).toHaveCount(0);

  // von außen: Startpasswort ändern, dann Code von der Liste
  const out = await outsideLogin(browser, username, startPassword);
  await expect(out.page).toHaveURL("/passwort");
  const pw = out.page.getByRole("form", { name: "Passwort ändern" });
  await pw.getByLabel("Bisheriges Passwort").fill(startPassword);
  await pw.getByLabel("Neues Passwort", { exact: true }).fill(NEW_PASSWORD);
  await pw.getByLabel("Neues Passwort wiederholen").fill(NEW_PASSWORD);
  await pw.getByRole("button", { name: "Passwort ändern" }).click();
  await out.page.getByRole("link", { name: "Weiter zu SchulOS" }).click();
  await expect(out.page).toHaveURL("/zwei-faktor");
  await expect(out.page.getByRole("note").first()).toContainText("außerhalb des Schulnetzes");
  // ohne Code nichts – auch keine API
  expect((await out.page.request.post("/api/eigenexport")).status()).toBe(403);
  const form = out.page.getByRole("form", { name: "Code von der Code-Liste" });
  await form.getByLabel("Code von deiner Code-Liste").fill("AAAAA-AAAAA");
  await form.getByRole("button", { name: "Weiter" }).click();
  await expect(form.getByRole("alert")).toContainText("stimmt nicht");
  await form.getByLabel("Code von deiner Code-Liste").fill(codes[0]!.toLowerCase());
  await form.getByRole("button", { name: "Weiter" }).click();
  await expect(out.page).toHaveURL("/");
  await out.ctx.close();

  // derselbe Code ein zweites Mal: abgelehnt; der nächste geht
  const again = await outsideLogin(browser, username, NEW_PASSWORD);
  await expect(again.page).toHaveURL("/zwei-faktor");
  const form2 = again.page.getByRole("form", { name: "Code von der Code-Liste" });
  await form2.getByLabel("Code von deiner Code-Liste").fill(codes[0]!);
  await form2.getByRole("button", { name: "Weiter" }).click();
  await expect(form2.getByRole("alert")).toContainText("schon benutzt");
  await form2.getByLabel("Code von deiner Code-Liste").fill(codes[1]!);
  await form2.getByRole("button", { name: "Weiter" }).click();
  await expect(again.page).toHaveURL("/");
  await again.ctx.close();

  // im Schulnetz: kein Code nötig
  const inside = await browser.newContext();
  const ip = await inside.newPage();
  await login(ip, username, NEW_PASSWORD);
  await inside.close();

  await page.reload();
  await expect(card.getByTestId("codeliste-status")).toContainText("noch 8 von 10 Codes");
  expect(errors).toEqual([]);
});
