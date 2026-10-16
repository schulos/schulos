import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

const SHOTS = ".data/shots/e2e";

/**
 * GATE-1-Szenario: Lehrkraft stellt Aufgabe → Schülerin gibt ab → Lehrkraft gibt Feedback.
 * Jeder Schritt meldet sich live per Gong beim Gegenüber.
 */
test("Gate 1: Aufgabe → Abgabe → Feedback, mit Gong bei jedem Schritt", async ({ browser }) => {
  const lk = await (await browser.newContext()).newPage();
  const sus = await (await browser.newContext()).newPage();
  const lkErrors = collectErrors(lk);
  const susErrors = collectErrors(sus);

  await login(lk, "jana.brandt");
  await login(sus, "lea.schaefer");
  const gongCount = async (page: typeof lk) => Number((await page.getByTestId("gong-count").textContent({ timeout: 500 }).catch(() => "0")) ?? 0);
  const susBefore = await gongCount(sus);

  // 1) Lehrkraft stellt die Aufgabe
  await lk.getByRole("link", { name: "Aufgaben", exact: true }).first().click();
  await lk.getByRole("link", { name: "Aufgabe stellen" }).click();
  await lk.getByLabel("Titel").fill("Erörterung Handyverbot");
  await lk.getByLabel("Aufgabenstellung").fill("Schreibe eine **Erörterung** (ca. 1 Seite).");
  await lk.getByLabel("Klasse 7b").check();
  await lk.getByLabel("Material (optional)").setInputFiles({ name: "Material.txt", mimeType: "text/plain", buffer: Buffer.from("Pro & Contra") });
  await lk.screenshot({ path: `${SHOTS}/aufgabe-neu.png`, fullPage: true });
  await lk.getByRole("button", { name: "Aufgabe stellen" }).click();
  await expect(lk.getByRole("heading", { name: "Erörterung Handyverbot" })).toBeVisible();
  await expect(lk.getByRole("heading", { name: /Abgaben \(0 von 25\)/ })).toBeVisible();
  const taskUrl = lk.url();

  // 2) Schülerin bekommt den Gong live, öffnet die Aufgabe darüber und gibt ab
  await expect(sus.getByTestId("gong-count")).toHaveText(String(susBefore + 1), { timeout: 10_000 });
  await expect(sus.locator('[data-widget="aufgaben.faellig"]')).toContainText("Erörterung Handyverbot");
  await sus.getByRole("button", { name: /Gong/ }).click();
  await sus.getByRole("button", { name: /Neue Aufgabe: Erörterung Handyverbot/ }).click();
  await expect(sus).toHaveURL(taskUrl);
  await expect(sus.getByRole("link", { name: /Material\.txt/ })).toBeVisible();
  await sus.getByRole("button", { name: "Abgeben" }).click();
  await expect(sus.locator("form").getByRole("alert")).toContainText("mindestens eine Datei");
  await sus.getByLabel("Dateien").setInputFiles({ name: "Erörterung-Lea.txt", mimeType: "text/plain", buffer: Buffer.from("Meine Erörterung …") });
  await sus.getByLabel(/Nachricht an die Lehrkraft/).fill("Hier meine Abgabe!");
  await sus.getByRole("button", { name: "Abgeben" }).click();
  await expect(sus.getByText("Abgegeben", { exact: true }).first()).toBeVisible();
  await sus.screenshot({ path: `${SHOTS}/aufgabe-abgegeben.png`, fullPage: true });

  // 3) Lehrkraft bekommt den Gong, öffnet die Abgabe und gibt Feedback
  await expect(lk.getByTestId("gong-count")).toBeVisible({ timeout: 10_000 });
  await lk.getByRole("button", { name: /Gong/ }).click();
  await lk.getByRole("button", { name: /Lea Schäfer hat „Erörterung Handyverbot“ abgegeben/ }).click();
  await expect(lk.getByRole("heading", { name: "Lea Schäfer" })).toBeVisible();
  await expect(lk.getByText("Hier meine Abgabe!")).toBeVisible();
  const dl = await lk.request.get((await lk.getByRole("link", { name: /Erörterung-Lea\.txt/ }).getAttribute("href"))!);
  expect(await dl.text()).toBe("Meine Erörterung …");
  await lk.getByLabel("Feedback").fill("Gut gegliedert, Gegenargumente noch stärker ausführen.");
  await lk.getByLabel("Bewertung").fill("2+");
  await lk.getByRole("button", { name: "Zurückgeben" }).click();
  await expect(lk).toHaveURL(taskUrl);
  await expect(lk.getByRole("row", { name: /Schäfer, Lea/ })).toContainText("Zurückgegeben");
  await lk.screenshot({ path: `${SHOTS}/aufgabe-matrix.png`, fullPage: true });

  // 4) Schülerin bekommt das Feedback per Gong
  await expect(sus.getByTestId("gong-count")).toBeVisible({ timeout: 10_000 });
  await sus.getByRole("button", { name: /Gong/ }).click();
  await sus.getByRole("button", { name: /Feedback zu „Erörterung Handyverbot“/ }).click();
  await expect(sus.getByText("Gegenargumente noch stärker ausführen")).toBeVisible();
  await expect(sus.getByText("2+", { exact: true })).toBeVisible();
  await expect(sus.getByRole("button", { name: /abgeben/i })).toHaveCount(0); // nach Rückgabe gesperrt
  await sus.screenshot({ path: `${SHOTS}/aufgabe-feedback.png`, fullPage: true });

  expect(lkErrors).toEqual([]);
  expect(susErrors).toEqual([]);
  await lk.context().close();
  await sus.context().close();
});

test("Fremde Klasse sieht die Aufgabe nicht; Eltern haben keinen Aufgaben-Eintrag", async ({ page }) => {
  await login(page, "jana.brandt");
  await page.goto("/aufgaben");
  const href = await page.getByRole("link", { name: /Erörterung Handyverbot/ }).first().getAttribute("href");
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: /Eltern von Lea/ }).click();
  await expect(page).toHaveURL("/");
  await expect(page.locator('[data-widget="heute.kinder"]')).toBeVisible(); // wirklich angemeldet
  await expect(page.getByRole("link", { name: "Aufgaben", exact: true })).toHaveCount(0);
  expect((await page.goto(href!))?.status()).toBe(404);
});
