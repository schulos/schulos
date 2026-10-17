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

test("Konferenzlink im Kursraum: Schule schaltet frei, Leitung hinterlegt, Schülerin öffnet (V-01)", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  const jana = await (await browser.newContext()).newPage();
  const lea = await (await browser.newContext()).newPage();
  const errors = collectErrors(jana);
  await login(admin, "admin");
  await login(jana, "jana.brandt");
  await login(lea, "lea.schaefer");
  const setting = async (value: "an" | "aus") => {
    await admin.goto("/verwaltung/rechte");
    await admin.getByLabel("Konferenzlinks im Kursraum").selectOption(value);
    await expect(admin.getByLabel("Konferenzlinks im Kursraum")).toHaveValue(value);
  };

  // Vorgabe aus: kein Knopf, auch nicht für die Leitung
  await jana.goto("/kurse/g-7b");
  await expect(jana.getByRole("button", { name: "Konferenzraum-Link hinterlegen" })).toHaveCount(0);

  await setting("an");
  try {
    await jana.reload();
    await jana.getByRole("button", { name: "Konferenzraum-Link hinterlegen" }).click();
    await jana.getByLabel("Adresse des Konferenzraums").fill("http://konferenz.example.org/raum-7b");
    await jana.getByRole("button", { name: "Speichern" }).click();
    await expect(jana.getByText("Nur Adressen mit https:// sind erlaubt")).toBeVisible();
    await jana.getByLabel("Adresse des Konferenzraums").fill("https://konferenz.example.org/raum-7b");
    await jana.getByLabel("Bezeichnung").fill("Videoraum 7b");
    await jana.getByRole("button", { name: "Speichern" }).click();
    await expect(jana.getByRole("link", { name: "Videoraum 7b öffnen" })).toBeVisible();

    await lea.goto("/kurse/g-7b");
    const link = lea.getByRole("link", { name: "Videoraum 7b öffnen" });
    await expect(link).toHaveAttribute("href", "https://konferenz.example.org/raum-7b");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(lea.getByText("öffnet konferenz.example.org")).toBeVisible();
    await expect(lea.getByRole("button", { name: "Link ändern" })).toHaveCount(0);
    await lea.screenshot({ path: ".data/shots/e2e/kurse-konferenz.png", fullPage: true });

    // Leitung entfernt den Link wieder
    await jana.getByRole("button", { name: "Link ändern" }).click();
    await jana.getByRole("button", { name: "Link entfernen" }).click();
    await expect(jana.getByRole("button", { name: "Konferenzraum-Link hinterlegen" })).toBeVisible();
  } finally {
    // zurück auf die Vorgabe (gemeinsame E2E-Datenbank)
    await setting("aus");
  }
  await lea.reload();
  await expect(lea.getByRole("link", { name: /öffnen$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
  for (const p of [admin, jana, lea]) await p.context().close();
});
