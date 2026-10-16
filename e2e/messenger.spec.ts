import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

/** Nur im Nachrichtenverlauf suchen (die Raumliste zeigt dieselben Texte als Vorschau). */
const chat = (p: Page) => p.getByRole("list", { name: "Nachrichten", exact: true });

test("Messenger: Klassenchat live, Ungelesen-Zähler, Direktchat mit Lesestatus", async ({ browser }) => {
  const lea = await (await browser.newContext()).newPage();
  const lk = await (await browser.newContext()).newPage();
  const leaErrors = collectErrors(lea);
  const lkErrors = collectErrors(lk);
  await login(lea, "lea.schaefer");
  await login(lk, "jana.brandt");

  // Lehrkraft wartet auf der Startseite; Lea schreibt in den Klassenchat
  await lea.getByRole("link", { name: /^Messenger/ }).first().click(); // Name enthält ggf. „1 ungelesen“
  await expect(lea).toHaveURL(/\/messenger/);
  await lea.getByRole("link", { name: /Klasse 7b/ }).click();
  await expect(chat(lea).getByText("Denkt an die Einverständniserklärung")).toBeVisible();
  const before = Number((await lk.getByTestId("badge-messenger").textContent({ timeout: 500 }).catch(() => "0"))?.replace(/\D/g, "") || 0);
  await lea.getByLabel("Nachricht", { exact: true }).fill("Bis wann brauchen Sie die Erklärung?");
  await lea.keyboard.press("Enter");
  await expect(chat(lea)).toContainText("Bis wann brauchen Sie die Erklärung?");

  // Zähler in der Navigation der Lehrkraft steigt live
  await expect(lk.getByTestId("badge-messenger")).toContainText(String(before + 1), { timeout: 10_000 });
  await lk.getByRole("link", { name: /^Messenger/ }).first().click();
  await expect(lk).toHaveURL(/\/messenger/);
  await lk.getByRole("link", { name: /Klasse 7b/ }).click();
  await expect(chat(lk).getByText("Bis wann brauchen Sie die Erklärung?")).toBeVisible();
  // zurück auf den Stand vor Leas Nachricht (Seed: weitere ungelesene Chats möglich)
  if (before === 0) await expect(lk.getByTestId("badge-messenger")).toHaveCount(0);
  else await expect(lk.getByTestId("badge-messenger")).toContainText(String(before));

  // Antwort kommt bei Lea live an
  await lk.getByLabel("Nachricht", { exact: true }).fill("Bis Freitag, bitte im Sekretariat abgeben.");
  await lk.getByRole("button", { name: "Senden" }).click();
  await expect(chat(lea).getByText("Bis Freitag, bitte im Sekretariat abgeben.")).toBeVisible({ timeout: 10_000 });
  await lea.screenshot({ path: ".data/shots/e2e/messenger-gruppe.png" });

  // Direktchat Lea → Brandt, Lesestatus
  await lea.getByRole("button", { name: "Neuer Chat" }).click();
  await lea.getByLabel("Person suchen").fill("BRA");
  await lea.getByRole("button", { name: /Jana Brandt/ }).click();
  await expect(lea.getByRole("heading", { name: "Jana Brandt" })).toBeVisible();
  await lea.getByLabel("Nachricht", { exact: true }).fill("Kann ich die Erörterung auch handschriftlich abgeben?");
  await lea.keyboard.press("Enter");
  await expect(lea.getByTestId("read-status")).toHaveCount(0);

  await lk.getByRole("link", { name: /Lea Schäfer/ }).click();
  await expect(chat(lk).getByText("Kann ich die Erörterung auch handschriftlich abgeben?")).toBeVisible({ timeout: 10_000 });
  await expect(lea.getByTestId("read-status")).toHaveText(/Gelesen/, { timeout: 10_000 });
  await lea.screenshot({ path: ".data/shots/e2e/messenger-direkt.png" });

  expect(leaErrors).toEqual([]);
  expect(lkErrors).toEqual([]);
  await lea.context().close();
  await lk.context().close();
});

test("Fremde kommen nicht in Klassenchats", async ({ page }) => {
  await login(page, "lea.schaefer");
  expect((await page.goto("/messenger/room-g-9a"))?.status()).toBe(404);
});
