import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

const SHOTS = ".data/shots/e2e";

test.describe("Verwaltung · Gruppen", () => {
  test("Liste mit Filter", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/gruppen?art=klasse");
    await expect(page.getByRole("link", { name: "Klasse 7b" })).toBeVisible();
    await expect(page.getByRole("link", { name: "AG Robotik" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Gruppe anlegen, Mitglieder pflegen, Leitung vergeben, löschen", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/gruppen/neu");
    await page.getByLabel("Name", { exact: true }).fill("AG Theater");
    await page.getByLabel("Art", { exact: true }).selectOption("ag");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("heading", { name: "AG Theater" })).toBeVisible();
    await expect(page.getByText("ag-theater")).toBeVisible();

    await page.getByLabel("Mitglied hinzufügen").fill("lea.sch");
    await page.getByRole("button", { name: "Lea Schäfer hinzufügen" }).click();
    await expect(page.getByRole("heading", { name: "Mitglieder (1)" })).toBeVisible();
    await page.getByLabel("Mitglied hinzufügen").fill("BRA");
    await page.getByRole("button", { name: "Jana Brandt hinzufügen" }).click();
    await expect(page.getByRole("heading", { name: "Mitglieder (2)" })).toBeVisible();

    await page.getByRole("button", { name: "Brandt, Jana: zur Leitung machen" }).click();
    await expect(page.getByRole("button", { name: "Brandt, Jana: Leitung entziehen" })).toBeVisible();
    await page.getByRole("button", { name: "Schäfer, Lea entfernen" }).click();
    await expect(page.getByRole("heading", { name: "Mitglieder (1)" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/verwaltung-gruppe.png`, fullPage: true });

    await page.getByRole("button", { name: "Löschen" }).click();
    await expect(page).toHaveURL("/verwaltung/gruppen");
    await expect(page.getByRole("link", { name: "AG Theater" })).toHaveCount(0);
  });
});
