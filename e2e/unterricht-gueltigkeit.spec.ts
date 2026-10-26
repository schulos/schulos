import { expect, test } from "@playwright/test";
import { collectErrors, login, pickTeacher } from "./helpers";

test.describe("Stundenplanung · Lehrauftrag mit Gültigkeit (SP2-09)", () => {
  test("Lehrauftrag ab dem 2. Halbjahr: heute „zu anderer Zeit gültig“, am Stichtag in der Verteilung; Planungsstand im Lauf", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto("/planung/unterricht?gruppe=g-7b");
    await page.getByRole("link", { name: "Lehrauftrag anlegen" }).click();
    await page.getByLabel("Fach").selectOption({ label: "Französisch" });
    await page.getByLabel("Wochenstunden").fill("2");
    await pickTeacher(page, "teacherId", "u-jana.brandt", { offSubject: true });
    // bis vor ab → Fehler
    await page.getByLabel("Gültig ab").fill("2027-02-01");
    await page.getByLabel("Gültig bis").fill("2027-01-31");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText("„gültig bis“ liegt vor „gültig ab“").first()).toBeVisible();
    await page.getByLabel("Gültig bis").fill("");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page).not.toHaveURL(/neu=/);

    // heute: nicht in der Tabelle, sondern unter „Zu anderer Zeit gültig“
    const other = page.getByRole("region", { name: "Zu anderer Zeit gültig" });
    await expect(other.getByText("ab 01.02.2027")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Französisch" }).filter({ has: page.getByRole("cell", { name: "BRA" }) })).toHaveCount(0);

    // am Stichtag 01.02.2027: in der Verteilung mit Gültigkeits-Hinweis
    await other.getByRole("link", { name: "am 01.02.2027 ansehen" }).click();
    await expect(page).toHaveURL(/stichtag=2027-02-01/);
    await expect(page.getByRole("textbox", { name: "Stichtag" })).toHaveValue("2027-02-01");
    const row = page.getByRole("row").filter({ hasText: "Französisch" }).filter({ has: page.getByRole("cell", { name: "BRA" }) });
    await expect(row.getByText("ab 01.02.2027")).toBeVisible();

    // Solver: Planungsstand im Startformular
    await page.goto("/planung/solver");
    await expect(page.getByLabel("Lehraufträge am")).toBeVisible();

    // aufräumen
    await page.goto("/planung/unterricht?gruppe=g-7b&stichtag=2027-02-01");
    await row.getByRole("link", { name: "Französisch" }).click();
    await expect(page.getByLabel("Gültig ab")).toHaveValue("2027-02-01");
    await page.getByRole("button", { name: "Lehrauftrag löschen" }).click();
    await expect(page).not.toHaveURL(/auftrag=/);
    await expect(row).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
