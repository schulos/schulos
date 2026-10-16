import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test("Lehrkraft legt eine anonyme Umfrage an die 7b an; Fehler behält die Fragen; Schülerin sieht sie", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/umfragen");
  await page.getByRole("link", { name: "Umfrage anlegen" }).click();
  await expect(page).toHaveURL("/umfragen/neu");

  await page.getByLabel("Titel").fill("Wie war die Klassenfahrt?");
  const q1 = page.getByRole("group", { name: "Frage 1" });
  await q1.getByLabel("Frage 1", { exact: true }).fill("Hat es dir gefallen?");
  await q1.getByLabel("Frage 1, Antwort 1").fill("Ja");
  await q1.getByLabel("Frage 1, Antwort 2").fill("Nein");
  await page.getByRole("button", { name: "Frage hinzufügen" }).click();
  const q2 = page.getByRole("group", { name: "Frage 2" });
  await q2.getByLabel("Frage 2", { exact: true }).fill("Was war am schönsten?");
  await q2.getByLabel("Art").selectOption({ label: "Freitext" });
  await expect(q2.getByText("Bitte keine Namen nennen.")).toBeVisible();

  // ohne Zielgruppe → Fehler, die Fragen bleiben stehen
  await page.getByRole("button", { name: "Umfrage anlegen" }).click();
  await expect(page.getByText("Bitte mindestens eine Zielgruppe wählen")).toBeVisible();
  await expect(q2.getByLabel("Frage 2", { exact: true })).toHaveValue("Was war am schönsten?");

  await page.getByLabel("Gruppe hinzufügen").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Umfrage anlegen" }).click();
  await expect(page).toHaveURL(/\/umfragen\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: "Wie war die Klassenfahrt?", level: 1 })).toBeVisible();
  await expect(page.getByText(/^0 von \d+ haben teilgenommen \(0 %\) · für Klasse 7b$/)).toBeVisible();
  // Jana ist als Klassenleitung selbst in der Zielgruppe und sieht deshalb das Antwortformular
  await expect(page.getByRole("group", { name: "2. Was war am schönsten?" })).toContainText("Bitte keine Namen nennen.");
  await page.screenshot({ path: ".data/shots/e2e/umfrage.png", fullPage: true });
  expect(errors).toEqual([]);

  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.goto("/umfragen");
  await expect(page.getByRole("link", { name: /Wie war die Klassenfahrt\?/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Umfrage anlegen" })).toHaveCount(0);
});

test("Umfrage an die Eltern der 7b: Elternteil sieht sie, die Schülerin nicht", async ({ page }) => {
  await login(page, "jana.brandt");
  await page.goto("/umfragen/neu");
  await page.getByLabel("Titel").fill("Elternabend: Termin");
  const q1 = page.getByRole("group", { name: "Frage 1" });
  await q1.getByLabel("Frage 1", { exact: true }).fill("Welcher Termin passt?");
  await q1.getByLabel("Frage 1, Antwort 1").fill("Dienstag");
  await q1.getByLabel("Frage 1, Antwort 2").fill("Donnerstag");
  await page.getByLabel("Gruppe hinzufügen").selectOption({ label: "Klasse 7b" });
  await page.getByLabel("Wer in Klasse 7b?").selectOption({ label: "Eltern der Schüler:innen" });
  await page.getByRole("button", { name: "Umfrage anlegen" }).click();
  await expect(page.getByText("für Eltern Klasse 7b")).toBeVisible();

  await logoutForSwitch(page);
  await login(page, "daniela.schaefer");
  await page.goto("/umfragen");
  await expect(page.getByRole("link", { name: /Elternabend: Termin/ })).toBeVisible();

  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.goto("/umfragen");
  await expect(page.getByRole("link", { name: /Elternabend: Termin/ })).toHaveCount(0);
});

async function createSurvey(page: import("@playwright/test").Page, title: string, anonymous: boolean) {
  await page.goto("/umfragen/neu");
  await page.getByLabel("Titel").fill(title);
  if (!anonymous) await page.getByRole("radio", { name: /Namentlich/ }).check();
  const q1 = page.getByRole("group", { name: "Frage 1" });
  await q1.getByLabel("Frage 1", { exact: true }).fill("Passt der Termin?");
  await q1.getByLabel("Frage 1, Antwort 1").fill("Ja");
  await q1.getByLabel("Frage 1, Antwort 2").fill("Nein");
  await page.getByRole("button", { name: "Frage hinzufügen" }).click();
  const q2 = page.getByRole("group", { name: "Frage 2" });
  await q2.getByLabel("Frage 2", { exact: true }).fill("Anmerkungen");
  await q2.getByLabel("Art").selectOption({ label: "Freitext" });
  await q2.getByRole("checkbox", { name: "Pflichtfrage" }).uncheck();
  await page.getByLabel("Gruppe hinzufügen").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Umfrage anlegen" }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  return page.url();
}

test("P3-04: anonym teilnehmen – Pflichtfrage, Danke, keine zweite Teilnahme; Lehrkraft sieht unter 5 Antworten nichts und erinnert", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  const url = await createSurvey(page, "Wandertag anonym", true);

  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.goto(url);
  await expect(page.getByText("Diese Umfrage ist anonym")).toBeVisible();
  await page.getByRole("button", { name: "Antworten senden" }).click();
  await expect(page.getByText("Bitte eine Antwort wählen")).toBeVisible();
  await page.getByRole("group", { name: "1. Passt der Termin?" }).getByRole("radio", { name: "Ja" }).check();
  await page.getByRole("textbox", { name: "Anmerkungen" }).fill("Bitte früh starten");
  await page.getByRole("button", { name: "Antworten senden" }).click();
  await expect(page.getByRole("status")).toContainText("Danke! Deine Antworten sind gespeichert.");
  await expect(page.getByRole("button", { name: "Antworten senden" })).toHaveCount(0);
  await page.goto("/umfragen");
  await expect(page.getByRole("link", { name: /Wandertag anonym/ })).toContainText("teilgenommen");
  expect(errors).toEqual([]);

  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto(url);
  await expect(page.getByText(/^1 von \d+ haben teilgenommen/)).toBeVisible();
  await expect(page.getByText("Noch zu wenige Antworten")).toBeVisible();
  await expect(page.getByRole("link", { name: "CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: /Personen erinnern/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "erinnert" })).toContainText(/\d+ Personen erinnert\./);
});

test("P3-04: namentlich – Lehrkraft sieht Balken, Freitext mit Namen und lädt die CSV", async ({ page }) => {
  await login(page, "jana.brandt");
  const url = await createSurvey(page, "Elterngespräch namentlich", false);
  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.goto(url);
  await expect(page.getByText("Diese Umfrage ist anonym")).toHaveCount(0);
  await page.getByRole("group", { name: "1. Passt der Termin?" }).getByRole("radio", { name: "Nein" }).check();
  await page.getByRole("textbox", { name: "Anmerkungen" }).fill("Lieber nachmittags");
  await page.getByRole("button", { name: "Antworten senden" }).click();
  await expect(page.getByRole("status")).toContainText("Danke!");

  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto(url);
  const results = page.getByRole("list", { name: "Ergebnisse je Frage" });
  await expect(results.getByRole("progressbar", { name: "Nein: 1 von 1" })).toBeVisible();
  await expect(results).toContainText("Lea Schäfer: Lieber nachmittags");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("umfrage-Elterngespräch-namentlich.csv");
  await page.screenshot({ path: ".data/shots/e2e/umfrage-auswertung.png", fullPage: true });
});
