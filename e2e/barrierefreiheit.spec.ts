import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// A11Y-02: Erklärung zur Barrierefreiheit – öffentlich, verlinkt auf der Anmeldeseite und im Benutzermenü; Angaben der Schule
// unter Verwaltung → Schule (Kontakt notfalls aus dem Impressum, Durchsetzungsverfahren NRW als Vorgabe).
test("A11Y-02: öffentliche Erklärung, Pflege unter Verwaltung → Schule", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/login");
  await page.getByRole("link", { name: "Barrierefreiheit" }).click();
  await expect(page).toHaveURL("/barrierefreiheit");
  await expect(page.getByRole("heading", { level: 1, name: "Erklärung zur Barrierefreiheit" })).toBeVisible();
  // ohne Datum der Überprüfung noch als Vorlage gekennzeichnet; Kontakt aus dem Impressum der Demo-Schule
  await expect(page.getByTestId("barrierefreiheit-vorlage")).toBeVisible();
  await expect(page.getByTestId("barrierefreiheit-stand")).toContainText("teilweise vereinbar");
  await expect(page.getByRole("heading", { name: "Nicht barrierefreie Inhalte" })).toBeVisible();
  await expect(page.getByText("BITV NRW").first()).toBeVisible();
  await expect(page.getByText("Ombudsstelle für barrierefreie Informationstechnik", { exact: false }).first()).toBeVisible();

  await login(page, "admin");
  await page.goto("/verwaltung/schule");
  const form = page.getByRole("form", { name: "Erklärung zur Barrierefreiheit" });
  await form.getByLabel("Datum der Überprüfung").fill("2026-10-14");
  await form.getByLabel("Ansprechstelle").fill("Sekretariat");
  await form.getByLabel("E-Mail für Rückmeldungen").fill("barrierefrei@lindenhof.example");
  await form.getByLabel("Weitere nicht barrierefreie Inhalte").fill("Eingescannte Elternbriefe ohne Textebene");
  await form.getByRole("button", { name: "Erklärung speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  // ungültige Telefonnummer wird abgelehnt (Server), die Eingaben bleiben stehen
  await form.getByLabel("Telefon für Rückmeldungen").fill("bitte anrufen");
  await form.getByRole("button", { name: "Erklärung speichern" }).click();
  await expect(form.getByRole("alert")).toContainText("markierten Felder");
  await expect(form.getByLabel("Ansprechstelle")).toHaveValue("Sekretariat");

  // im Benutzermenü verlinkt
  await page.getByRole("button", { name: "Profilmenü öffnen" }).click();
  await page.getByRole("menuitem", { name: "Erklärung zur Barrierefreiheit" }).click();
  await expect(page).toHaveURL("/barrierefreiheit");
  await expect(page.getByTestId("barrierefreiheit-vorlage")).toHaveCount(0);
  await expect(page.getByText("14. Oktober 2026")).toBeVisible();
  await expect(page.getByTestId("barrierefreiheit-kontakt")).toContainText("barrierefrei@lindenhof.example");
  await expect(page.getByText("an Sekretariat")).toBeVisible();
  await expect(page.getByText("Eingescannte Elternbriefe ohne Textebene")).toBeVisible();
  expect(errors).toEqual([]);
});

// AGPL § 13 (Q-4E-31): Quellcode-Hinweis auf der Anmeldeseite und im Benutzermenü (neues Fenster, ohne Opener)
test("Q-4E-31: Link zum Quellcode auf der Anmeldeseite und im Benutzermenü", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/login");
  const link = page.getByRole("link", { name: /^Quellcode \(AGPL\)/ });
  await expect(link).toHaveAttribute("href", /^https:\/\/github\.com\/schulos\/schulos/);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await login(page, "admin");
  await page.getByRole("button", { name: "Profilmenü öffnen" }).click();
  await expect(page.getByRole("menuitem", { name: /^Quellcode \(AGPL\)/ })).toHaveAttribute("href", /^https:\/\/github\.com\/schulos\/schulos/);
  expect(errors).toEqual([]);
});
