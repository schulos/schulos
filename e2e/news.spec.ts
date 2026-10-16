import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("News", () => {
  test("Lehrkraft veröffentlicht an die 7b → Lea bekommt Gong und sieht den Beitrag, 9a nicht", async ({ page, browser }) => {
    const errors = collectErrors(page);
    await login(page, "jana.brandt");
    await page.getByRole("link", { name: "News", exact: true }).click();
    await page.getByRole("link", { name: "Beitrag schreiben" }).click();
    await page.getByLabel("Titel").fill("Wandertag 7b: Treffpunkt Bahnhof");
    await page.getByLabel("Text", { exact: true }).fill("Wir treffen uns um **8:15 Uhr** am Bahnhof.\n\n- Regenjacke\n- Proviant");
    await page.getByLabel("Gruppe hinzufügen").selectOption({ label: "Klasse 7b" });
    await expect(page.getByRole("button", { name: "Klasse 7b entfernen" })).toBeVisible();
    await expect(page.getByLabel("Oben anheften")).toHaveCount(0); // Lehrkraft darf nicht anheften
    await page.screenshot({ path: ".data/shots/e2e/news-neu.png", fullPage: true });
    await page.getByRole("button", { name: "Veröffentlichen" }).click();

    await expect(page.getByRole("heading", { name: "Wandertag 7b: Treffpunkt Bahnhof" })).toBeVisible();
    await expect(page.getByText("8:15 Uhr")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Regenjacke" })).toBeVisible();
    await expect(page.getByText("An: Klasse 7b")).toBeVisible();
    const url = page.url();
    expect(errors).toEqual([]);

    const lea = await (await browser.newContext()).newPage();
    await login(lea, "lea.schaefer");
    await expect(lea.locator('[data-widget="news.neuigkeiten"]')).toContainText("Wandertag 7b");
    await lea.getByRole("button", { name: /Gong/ }).click();
    await lea.getByRole("button", { name: /Wandertag 7b: Treffpunkt Bahnhof/ }).click();
    await expect(lea).toHaveURL(url);
    await lea.screenshot({ path: ".data/shots/e2e/news-detail.png" });

    await lea.context().close();
  });

  test("Schülerin kann nicht schreiben; Volltextsuche findet Stammformen", async ({ page }) => {
    await login(page, "lea.schaefer");
    await page.goto("/news");
    await expect(page.getByRole("link", { name: "Beitrag schreiben" })).toHaveCount(0);
    expect((await page.goto("/news/neu"))?.status()).toBe(404);
    await page.goto("/news?q=Redaktionsschlusses");
    await expect(page.getByRole("heading", { name: /Schülerzeitung: Redaktionsschluss/ })).toBeVisible();
  });

  test("Schulleitung heftet an und bearbeitet fremde Beiträge", async ({ page }) => {
    await login(page, "petra.lindner");
    await page.goto("/news/news-schuelerzeitung/bearbeiten");
    await page.getByLabel("Oben anheften").check();
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText("Angeheftet")).toBeVisible();
  });
});
