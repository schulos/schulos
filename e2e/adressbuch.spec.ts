import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("Adressbuch", () => {
  test("Schülerin: Lehrkräfte, eigene Klasse, gemeinsame Gruppen – fremde Klassen nicht", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "lea.schaefer");
    await page.getByRole("link", { name: "Adressbuch" }).click();
    await expect(page.getByRole("heading", { name: "Lehrkräfte (28)" })).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/adressbuch.png" });

    await page.getByRole("link", { name: /Brandt, Jana/ }).click();
    await expect(page.getByRole("heading", { name: "Jana Brandt" })).toBeVisible();
    await expect(page.getByText("Klassenleitung 7b")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gemeinsame Gruppen" })).toBeVisible();
    await page.getByRole("link", { name: /Klasse 7b/ }).click();
    await expect(page.getByRole("heading", { name: "Klasse 7b" })).toBeVisible();
    expect(errors).toEqual([]); // vor dem absichtlichen 404

    expect((await page.goto("/adressbuch/gruppe/g-9a"))?.status()).toBe(404);
    await page.goto("/adressbuch?q=9a");
    await expect(page.getByText("Nichts gefunden für „9a“")).toBeVisible();
  });

  test("Lehrkraft findet Schüler:innen anderer Klassen", async ({ page }) => {
    await login(page, "jana.brandt");
    await page.goto("/adressbuch?q=9a");
    await expect(page.getByRole("link", { name: /Klasse 9a/ })).toBeVisible();
  });
});

test("Schulsozialarbeit (Rolle Beratung, Q5-17): im Adressbuch mit Sprechzeiten, Chat bleibt ohne Freigabe aus", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  await page.goto("/adressbuch");
  const card = page.getByRole("heading", { name: "Schulsozialarbeit & Beratung" });
  await expect(card).toBeVisible();
  await page.getByRole("link", { name: /Ostermann, Nina/ }).click();
  await expect(page.getByRole("heading", { name: "Nina Ostermann" })).toBeVisible();
  await expect(page.getByText("Di und Do 9–13 Uhr, Raum A 0.14")).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/adressbuch-beratung.png" });

  // Chat-Funktion erst nach DSB-Votum (Moduleinstellung, Vorgabe aus): im Messenger nicht auffindbar
  await page.goto("/messenger");
  await page.getByRole("button", { name: "Neuer Chat" }).click();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/messenger"));
  await page.getByLabel("Person suchen").fill("Ostermann");
  await answered;
  await expect(page.getByRole("button", { name: /Nina Ostermann/ })).toHaveCount(0);
  expect(errors).toEqual([]);

  // die Beratung selbst sieht kein Klassenverzeichnis
  await page.context().clearCookies();
  await login(page, "nina.ostermann");
  await page.goto("/adressbuch?q=Schäfer");
  await expect(page.getByRole("link", { name: /Lea Schäfer/ })).toHaveCount(0);
  expect((await page.goto("/adressbuch/gruppe/g-7b"))?.status()).toBe(404);
});

test("Q5-25: Schulsozialarbeit pflegt Sprechzeiten und Raum selbst – andere Rollen haben die Seite nicht", async ({ page }) => {
  const errors = collectErrors(page);
  const original = "Di und Do 9–13 Uhr, Raum A 0.14 (neben dem Sekretariat)";
  await login(page, "nina.ostermann");
  await page.getByRole("button", { name: "Profilmenü öffnen" }).click();
  await page.getByRole("menuitem", { name: "Sprechzeiten und Raum" }).click();
  await expect(page.getByRole("heading", { name: "Sprechzeiten und Raum" })).toBeVisible();
  const field = page.getByRole("textbox", { name: "Sprechzeiten und Raum" });
  await expect(field).toHaveValue(original);
  await field.fill("Mo + Mi 8–12 Uhr, Raum B 1.02");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status")).toContainText("Gespeichert");
  // Seite erst verlassen: sonst öffnet der gerade geladene Tab seinen Live-Strom (/api/gong/stream) womöglich erst nach dem
  // Löschen der Cookies – das ergibt ein 401 in der Konsole (Wettlauf im Test, kein App-Fehler)
  await page.goto("about:blank");
  await page.context().clearCookies();

  await login(page, "lea.schaefer");
  await page.goto("/adressbuch");
  await page.getByRole("link", { name: /Ostermann, Nina/ }).click();
  await expect(page.getByText("Mo + Mi 8–12 Uhr, Raum B 1.02")).toBeVisible();
  expect((await page.goto("/konto/sprechzeiten"))?.status()).toBe(404);
  await page.goto("about:blank");
  await page.context().clearCookies();

  // zurück auf den Demo-Stand (andere Specs erwarten ihn)
  await login(page, "nina.ostermann");
  await page.goto("/konto/sprechzeiten");
  await page.getByRole("textbox", { name: "Sprechzeiten und Raum" }).fill(original);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status")).toContainText("Gespeichert");
  expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
});
