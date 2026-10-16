import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

/** Link aus der neuesten Mail an `to` (nur Dev/E2E: /dev/mail, angemeldet mit verwaltung.system). */
async function linkFromDevMail(page: Page, to: string, pathPrefix: string): Promise<string> {
  await logoutForSwitch(page);
  await login(page, "admin");
  await page.goto("/dev/mail");
  const mail = page.getByRole("article").filter({ has: page.getByTestId("mail-to").getByText(to, { exact: true }) }).first();
  const text = await mail.getByTestId("mail-text").innerText();
  const url = text.split(/\s+/).find((w) => w.includes(pathPrefix));
  expect(url, `Link ${pathPrefix} in der Mail`).toBeTruthy();
  return new URL(url!).pathname;
}

test("Q5-04: Lehrkraft trägt E-Mail-Adresse ein und bestätigt sie per Link", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/konto/email");
  await expect(page.getByRole("article", { name: "Aktuelle Adresse" })).toContainText("Keine E-Mail-Adresse");
  const form = page.getByRole("form", { name: "E-Mail-Adresse ändern" });
  await form.getByLabel("E-Mail-Adresse", { exact: true }).fill("jana.e2e@example.org");
  await form.getByRole("button", { name: "Bestätigungslink senden" }).click();
  await expect(form.getByRole("status")).toContainText("Bestätigungslink an jana.e2e@example.org");

  const path = await linkFromDevMail(page, "jana.e2e@example.org", "/konto/email/");
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto(path);
  await expect(page.getByText("jana.e2e@example.org wird die E-Mail-Adresse")).toBeVisible();
  await page.getByRole("button", { name: "Adresse bestätigen" }).click();
  await expect(page).toHaveURL(/\/konto\/email\?bestaetigt=1$/);
  await expect(page.getByTestId("eigene-email")).toHaveText("jana.e2e@example.org");
  await expect(page.getByRole("article", { name: "Aktuelle Adresse" })).toContainText("bestätigt");
  // ein zweites Mal gilt der Link nicht
  await page.goto(path);
  await expect(page.getByText("Der Link ist ungültig oder abgelaufen")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Q5-04: Schülerin ändert ihre Adresse nicht selbst; Verwaltung trägt sie ein (unbestätigt)", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  await page.goto("/konto/email");
  await expect(page.getByText("Bei Schüler:innen trägt das Sekretariat")).toBeVisible();
  await expect(page.getByRole("form", { name: "E-Mail-Adresse ändern" })).toHaveCount(0);

  await logoutForSwitch(page);
  await login(page, "admin");
  await page.goto("/verwaltung/benutzer/u-lea.schaefer");
  await page.getByLabel("E-Mail-Adresse", { exact: true }).fill("lea.e2e@example.org");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse", { exact: true })).toHaveValue("lea.e2e@example.org");
  expect(errors).toEqual([]);
});
