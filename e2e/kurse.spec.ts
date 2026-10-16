import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Schülerin öffnet ihre Klasse im Kursraum", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  await page.goto("/kurse");
  await expect(page.getByRole("heading", { name: "Meine Kurse", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Suchen", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: /^Klasse 7b/ }).click();
  await expect(page).toHaveURL(/\/kurse\/g-7b$/);
  await expect(page.getByRole("heading", { name: "Klasse 7b", level: 1 })).toBeVisible();
  for (const section of ["Nächste Stunden", "Offene Aufgaben", "Termine", "Gruppenordner", "Gruppenchat"]) {
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: /^Mitglieder \(\d+\)$/ })).toBeVisible();
  await page.getByRole("link", { name: "Zum Chat" }).click();
  await expect(page).toHaveURL(/\/messenger\/room-g-7b$/);
  await page.screenshot({ path: ".data/shots/e2e/kurse.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("fremder Kursraum ist für Schüler:innen gesperrt", async ({ page }) => {
  await login(page, "lea.schaefer");
  const res = await page.goto("/kurse/g-q1-e-gk1");
  expect(res?.status()).toBe(404);
});

test("Verwaltung findet einen Kursraum über die Suche und sieht ihn ohne Mitgliedschaft", async ({ page }) => {
  await login(page, "sabine.kowalski");
  await page.goto("/kurse");
  await page.getByRole("searchbox", { name: "Gruppe suchen" }).fill("7b");
  await page.getByRole("button", { name: "Suchen", exact: true }).click();
  await page.getByRole("link", { name: /^Klasse 7b/ }).click();
  await expect(page.getByRole("heading", { name: "Klasse 7b", level: 1 })).toBeVisible();
  await expect(page.getByText("ohne Mitglied der Gruppe zu sein")).toBeVisible();
  await expect(page.getByText("Nur für Mitglieder der Gruppe sichtbar.").first()).toBeVisible();
});

test("P3-02: Lehrkraft öffnet ihren Kurs über das Widget, sieht Aufgabe und Chat und schaltet den Chat ab und wieder an", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  const widget = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Meine Kurse" }) });
  await widget.getByRole("link", { name: /Klasse 7b/ }).click();
  await expect(page.getByRole("heading", { name: "Klasse 7b", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Erörterung „Handyverbot an Schulen“/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gruppenchat", exact: true })).toBeVisible();

  const chat = page.getByRole("checkbox", { name: /Gruppenchat/ });
  await expect(chat).toBeChecked();
  await chat.uncheck();
  await expect(page.getByRole("heading", { name: "Gruppenchat", exact: true })).toHaveCount(0);
  await expect(chat).not.toBeChecked();
  await chat.check();
  await expect(page.getByRole("heading", { name: "Gruppenchat", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("P3-02: Kurse in der Suche; Schüler:innen schalten keine Bereiche", async ({ page }) => {
  await login(page, "lea.schaefer");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Wohin möchtest du/).fill("7b");
  await page.getByRole("option", { name: /Klasse 7b/ }).filter({ hasText: "Mitglieder" }).click();
  await expect(page).toHaveURL(/\/kurse\/g-7b$/);
  await expect(page.getByRole("heading", { name: "Bereiche des Kurses" })).toHaveCount(0);
});
