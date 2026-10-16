import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("Statusmonitor", () => {
  test("Monitor anlegen, Adresse ohne Login öffnen, erneuern und sperren", async ({ page, browser }) => {
    page.on("dialog", (d) => void d.accept());
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung");
    await page.getByRole("navigation", { name: "Verwaltung" }).getByRole("link", { name: "Monitore", exact: true }).click();
    await expect(page.getByRole("list", { name: "Monitore" })).toContainText("Foyer Hauptgebäude");

    await page.getByLabel("Name", { exact: true }).last().fill("Mensa-Bildschirm");
    await page.getByRole("button", { name: "Anlegen" }).click();
    const url = await page.getByTestId("monitor-url").textContent();
    expect(url).toMatch(/\/monitor\/[\w-]{20,}$/);
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-monitore.png", fullPage: true });

    // Bildschirm: eigener Browser ohne Anmeldung
    const screen = await (await browser.newContext()).newPage();
    const screenErrors = collectErrors(screen);
    await screen.goto(url!);
    await expect(screen.getByRole("heading", { name: "Vertretungsplan" })).toBeVisible();
    await expect(screen.getByLabel("Uhrzeit")).toHaveText(/\d{2}:\d{2}/);
    await expect(screen.locator("main")).toHaveAttribute("data-profile", "foyer");

    await page.reload();
    const item = page.getByRole("listitem").filter({ hasText: "Mensa-Bildschirm" });
    await expect(item).toContainText("zuletzt gesehen gerade eben");
    await item.getByRole("button", { name: "Neue Adresse" }).click();
    await expect(page.getByTestId("monitor-url")).not.toHaveText(url!);
    const renewed = await page.getByTestId("monitor-url").textContent();
    await screen.goto(url!);
    await expect(screen.getByRole("heading", { name: "Monitor nicht verfügbar" })).toBeVisible();

    await page.reload();
    await page.getByRole("listitem").filter({ hasText: "Mensa-Bildschirm" }).getByRole("button", { name: "Sperren" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Mensa-Bildschirm" })).toContainText("gesperrt");
    await screen.goto(renewed!);
    await expect(screen.getByRole("heading", { name: "Monitor nicht verfügbar" })).toBeVisible();
    await screen.context().close();

    await page.getByRole("button", { name: "Mensa-Bildschirm löschen" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Mensa-Bildschirm" })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(screenErrors).toEqual([]);
  });

  test("Demo-Monitor: Laufband aus News, Lehrerzimmer-Spalte, Offline-Hinweis bei Netzausfall", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    await page.clock.install();
    await page.goto("/monitor/demo-foyer-lindenhof-2026");
    await expect(page.getByRole("region", { name: "Laufband" })).toContainText("Neuer Speiseplan für die Woche ist online");
    await expect(page.getByRole("columnheader", { name: "für" })).toHaveCount(0);
    await page.screenshot({ path: ".data/shots/e2e/monitor-foyer.png" });

    await page.route("**/api/monitor/**", (route) => route.abort());
    await page.clock.fastForward(61_000);
    await expect(page.getByRole("status")).toContainText("Keine Verbindung seit");
    await expect(page.getByRole("heading", { name: "Vertretungsplan" })).toBeVisible(); // letzter Stand bleibt

    await page.goto("/monitor/demo-lehrerzimmer-lindenhof-2026");
    await expect(page.locator("main")).toHaveAttribute("data-profile", "lehrerzimmer");
    await ctx.close();
  });
});
