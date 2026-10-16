import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// Review 2026-10-10: ein ausgeschaltetes Modul ist auch per direktem Aufruf zu (Seiten, Druck, API) – nicht nur aus der Navigation weg.
test("Modul ausgeschaltet → Seiten, Druckansicht und API antworten mit 404; eingeschaltet wieder erreichbar", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/verwaltung/rechte");
  const toggle = page.getByRole("checkbox", { name: "Modul Pinnwände", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  // gespeichert? (der Haken wird optimistisch gesetzt – erst neu laden zeigt den Serverstand)
  await expect(async () => {
    await page.reload();
    await expect(toggle).not.toBeChecked({ timeout: 1000 });
  }).toPass();
  try {
    const res = await page.goto("/pinnwaende");
    expect(res?.status()).toBe(404);
    expect((await page.goto("/druck/pinnwand/board-7b-projekt"))?.status()).toBe(404);
    await page.goto("/verwaltung/rechte");
    const umfragen = page.getByRole("checkbox", { name: "Modul Umfragen", exact: true });
    await umfragen.uncheck();
    await expect(async () => {
      await page.reload();
      await expect(umfragen).not.toBeChecked({ timeout: 1000 });
    }).toPass();
    expect((await page.request.get("/api/umfragen/irgendeine/csv")).status()).toBe(404);
    await umfragen.check();
    await expect(async () => {
      await page.reload();
      await expect(umfragen).toBeChecked({ timeout: 1000 });
    }).toPass();
    // SEC-05: Dateiablage aus → Upload und Download per API zu
    const dateien = page.getByRole("checkbox", { name: "Modul Dateien", exact: true });
    await dateien.uncheck();
    await expect(async () => {
      await page.reload();
      await expect(dateien).not.toBeChecked({ timeout: 1000 });
    }).toPass();
    try {
      expect((await page.request.post("/api/dateien/upload", { multipart: { space: "personal" } })).status()).toBe(404);
      expect((await page.request.get("/api/dateien/irgendeine")).status()).toBe(404);
    } finally {
      await dateien.check();
    }
    await expect(async () => {
      await page.reload();
      await expect(dateien).toBeChecked({ timeout: 1000 });
    }).toPass();
  } finally {
    await page.goto("/verwaltung/rechte");
    await page.getByRole("checkbox", { name: "Modul Pinnwände", exact: true }).check();
  }
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Modul Pinnwände", exact: true })).toBeChecked({ timeout: 1000 });
  }).toPass();
  expect((await page.goto("/pinnwaende"))?.status()).toBe(200);
});
