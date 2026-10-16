import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("Kalender", () => {
  test("Monats-, Wochen- und Agendaansicht zeigen Klassen- und Schultermine", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "lea.schaefer");
    await expect(page.locator('[data-widget="kalender.woche"]')).toBeVisible();
    await page.getByRole("link", { name: "Kalender", exact: true }).first().click();
    await expect(page.getByRole("link", { name: /Elternsprechtag/ }).first()).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/kalender-monat.png", fullPage: true });
    await page.getByRole("link", { name: "woche", exact: true }).click();
    await expect(page.getByRole("link", { name: /Redaktionstreffen/ }).first()).toBeVisible();
    await page.getByRole("link", { name: "agenda", exact: true }).click();
    await expect(page.getByText("Wandertag 7b").first()).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/kalender-agenda.png", fullPage: true });
    await expect(page.getByText("Korrekturen Erörterung 7b")).toHaveCount(0); // privat von Frau Brandt
    expect(errors).toEqual([]);
  });

  test("Lehrkraft legt Klassentermin als Serie an – Lea sieht ihn; ICS-Export", async ({ page, browser }) => {
    page.on("dialog", (d) => void d.accept());
    await login(page, "jana.brandt");
    await page.goto("/kalender/neu");
    await page.getByLabel("Titel").fill("Lernzeit 7b");
    await page.getByLabel("Kalender").selectOption({ label: "Klasse 7b" });
    await page.getByLabel("Jede Woche wiederholen").check();
    const until = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await page.getByLabel("Wiederholen bis").fill(until);
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("heading", { name: "Lernzeit 7b" })).toBeVisible();
    await expect(page.getByText(/Jede Woche bis/)).toBeVisible();

    const res = await page.request.get("/api/kalender/ics?kal=group:g-7b");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/calendar");
    const ics = await res.text();
    expect(ics).toContain("SUMMARY:Lernzeit 7b");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;UNTIL=");

    const lea = await (await browser.newContext()).newPage();
    await login(lea, "lea.schaefer");
    await lea.goto("/kalender?ansicht=agenda");
    await expect(lea.getByText("Lernzeit 7b").first()).toBeVisible();
    expect((await lea.request.get("/api/kalender/ics?kal=group:g-9a")).status()).toBe(404);
    await lea.context().close();
  });

  test("Fehler (Ende vor Beginn): Eingaben bleiben stehen", async ({ page }) => {
    await login(page, "jana.brandt");
    await page.goto("/kalender/neu");
    await page.getByLabel("Titel").fill("Elternsprechtag 7b");
    await page.getByLabel("Ort").fill("Raum 204");
    await page.getByLabel("Kalender").selectOption({ label: "Klasse 7b" });
    await page.getByLabel("Beginn").fill("2026-11-12T16:00");
    // exact: „Ende“ steckt auch in „Kalender“
    await page.getByLabel("Ende", { exact: true }).fill("2026-11-12T15:00");
    await page.getByLabel("Beschreibung").fill("Bitte Termine über die Klassenleitung");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Ende liegt vor dem Beginn" })).toBeVisible();
    await expect(page.getByLabel("Titel")).toHaveValue("Elternsprechtag 7b");
    await expect(page.getByLabel("Ort")).toHaveValue("Raum 204");
    await expect(page.getByLabel("Kalender").locator("option:checked")).toHaveText("Klasse 7b");
    await expect(page.getByLabel("Beginn")).toHaveValue("2026-11-12T16:00");
    await expect(page.getByLabel("Ende", { exact: true })).toHaveValue("2026-11-12T15:00");
    await expect(page.getByLabel("Beschreibung")).toHaveValue("Bitte Termine über die Klassenleitung");
  });

  test("Schülerin kann nicht in den Klassenkalender schreiben", async ({ page }) => {
    await login(page, "lea.schaefer");
    await page.goto("/kalender/neu");
    await expect(page.getByLabel("Kalender").locator("option")).toHaveText(["Persönlich"]);
  });
});
