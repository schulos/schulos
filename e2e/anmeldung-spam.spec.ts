import { expect, test, type Page } from "@playwright/test";
import { createOpenVerfahren, fillAnmeldung, linkFromDevMail } from "./anmeldung-helpers";
import { collectErrors, login, logoutForSwitch } from "./helpers";

async function anmelden(page: Page, id: string, first: string, ip: string, time = "14:00–14:30") {
  const email = `${first.toLowerCase()}.p478@example.org`;
  await fillAnmeldung(page, id, { first, last: "Spamprobe", email, time }, { ip });
  const confirmPath = await linkFromDevMail(page, email, "/anmeldung/bestaetigen/");
  await page.goto(confirmPath);
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page).toHaveURL(/\/anmeldung\/vorgang\//);
  await logoutForSwitch(page);
}

test("P4-78/P4-78b: Sekretariat markiert Spam-Verdacht, Schulleitung bestätigt gesammelt – ohne Mail", async ({ page }) => {
  const id = await createOpenVerfahren(page, "E2E Spam Klasse 5", "2030-03-12");
  await anmelden(page, id, "Bot", "198.51.100.78");
  await anmelden(page, id, "Robo", "198.51.100.79");
  await anmelden(page, id, "Echt", "198.51.100.80", "14:30–15:00");

  const errors = collectErrors(page);
  // Sekretariat: markieren (kein Ablehnen – das ist eine Entscheidung), einen Irrtum zurücknehmen
  await login(page, "sabine.kowalski");
  await page.goto(`/verwaltung/anmeldung/${id}/antraege`);
  await expect(page.getByRole("button", { name: "Als Spam ablehnen" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Alle offenen auswählen" }).check();
  await expect(page.getByTestId("spam-auswahl")).toHaveText("3 Anträge ausgewählt");
  await page.getByRole("button", { name: "Als Spam-Verdacht markieren" }).click();
  await expect(page.getByRole("status")).toHaveText("3 Anträge als Spam-Verdacht markiert.");
  const table = page.getByRole("form", { name: "Anträge" });
  await expect(table.getByText("Spam-Verdacht", { exact: true })).toHaveCount(3);
  await page.getByRole("checkbox", { name: "Spamprobe, Echt auswählen" }).check();
  await page.getByRole("button", { name: "Markierung zurücknehmen" }).click();
  await expect(page.getByRole("status")).toHaveText("Spam-Verdacht bei 1 Antrag zurückgenommen.");
  await expect(table.getByText("Spam-Verdacht", { exact: true })).toHaveCount(2);
  await expect(table.getByText("Abgelehnt (Spam)")).toHaveCount(0);
  await logoutForSwitch(page);

  // Schulleitung: Hinweis, alle Markierten auswählen, als Spam ablehnen
  await login(page, "petra.lindner");
  await page.goto(`/verwaltung/anmeldung/${id}/antraege`);
  await expect(page.getByTestId("spam-verdacht-hinweis")).toContainText("2 Anträge sind als Spam-Verdacht markiert");
  await page.getByRole("button", { name: "Alle mit Spam-Verdacht auswählen" }).click();
  await expect(page.getByTestId("spam-auswahl")).toHaveText("2 Anträge ausgewählt");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Als Spam ablehnen" }).click();
  await expect(page.getByRole("status")).toHaveText("2 Anträge als Spam abgelehnt.");
  await expect(table.getByText("Abgelehnt (Spam)")).toHaveCount(2);
  await expect(table.getByText("Spam-Verdacht", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Spamprobe, Bot auswählen" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Spamprobe, Echt auswählen" })).toHaveCount(1);

  // dass keine Mail an die Adressen geht, prüft spam.test.ts
  expect(errors).toEqual([]);
});
