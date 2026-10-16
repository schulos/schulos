import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("Verwaltung · Rechte & Module", () => {
  test("Sekretariat sieht keine Rechteverwaltung, Schulleitung schon", async ({ page }) => {
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung");
    await expect(page.getByRole("link", { name: "Rechte & Module" })).toHaveCount(0);
    expect((await page.goto("/verwaltung/rechte"))?.status()).toBe(404);

    await page.context().clearCookies();
    await login(page, "petra.lindner");
    await page.goto("/verwaltung/rechte");
    await expect(page.getByRole("heading", { name: "Rechte & Module" })).toBeVisible();
  });

  test("Rolle bekommt Recht → Lehrkraft sieht Verwaltung; wieder entziehen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "admin");
    await page.goto("/verwaltung/rechte");
    const box = page.getByRole("checkbox", { name: "Verwaltungsbereich öffnen für Lehrkraft" });
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Verwaltungsbereich öffnen für Lehrkraft" })).toBeChecked();
    await page.screenshot({ path: ".data/shots/e2e/verwaltung-rechte.png", fullPage: true });

    await page.context().clearCookies();
    await login(page, "jana.brandt");
    await expect(page.getByRole("link", { name: "Verwaltung" })).toBeVisible();

    await page.context().clearCookies();
    await login(page, "admin");
    await page.goto("/verwaltung/rechte");
    await page.getByRole("checkbox", { name: "Verwaltungsbereich öffnen für Lehrkraft" }).uncheck();
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Verwaltungsbereich öffnen für Lehrkraft" })).not.toBeChecked();
    expect(errors).toEqual([]);
  });

  test("Gruppen-Recht vergeben und entziehen", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/verwaltung/rechte");
    await page.getByLabel("Gruppe", { exact: true }).selectOption({ label: "Schülervertretung" });
    await page.getByLabel("Recht", { exact: true }).selectOption({ label: "Verwaltung: Verwaltungsbereich öffnen" });
    await page.getByRole("button", { name: "Recht vergeben" }).click();
    const remove = page.getByRole("button", { name: "Schülervertretung: Verwaltung: Verwaltungsbereich öffnen entziehen" });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(remove).toHaveCount(0);
  });

  test("Kernmodule lassen sich nicht abschalten", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/verwaltung/rechte");
    await expect(page.getByRole("checkbox", { name: "Modul Verwaltung" })).toBeDisabled();
  });
});

test("Protokoll zeigt Änderungen aus der Verwaltung", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/verwaltung/rechte");
  await page.getByRole("checkbox", { name: "Benutzer verwalten für Lehrkraft" }).check();
  await page.getByRole("checkbox", { name: "Benutzer verwalten für Lehrkraft" }).uncheck();
  await page.goto("/verwaltung/protokoll?bereich=verwaltung.rights.");
  const rows = page.getByRole("row", { name: /Rolle Lehrkraft.*verwaltung\.users/ });
  await expect(rows.first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Recht entzogen" }).first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/verwaltung-protokoll.png" });
});
