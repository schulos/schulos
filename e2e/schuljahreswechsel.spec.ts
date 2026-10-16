import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// Der volle Durchlauf (Versetzung, Archivieren, Abschluss) würde die gemeinsame E2E-DB für spätere Specs verändern;
// die Schritte sind in schuljahreswechsel.test.ts abgedeckt. Hier: Zugriff, Archivexport und Übergabe.
test("Schuljahreswechsel: nur mit Datenschutz-Recht, Klassenbuch-Archivexport als ZIP, Übergabe bestätigen", async ({ page }) => {
  await login(page, "jana.brandt");
  expect((await page.goto("/verwaltung/schuljahreswechsel"))?.status()).toBe(404);
  expect((await page.request.post("/api/klassenbuch/archiv/x")).status()).toBe(403);
  await logoutForSwitch(page);

  const errors = collectErrors(page);
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/datenschutz");
  await page.getByRole("link", { name: "Schuljahreswechsel" }).first().click();
  await expect(page.getByRole("heading", { name: "Schuljahreswechsel", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Folgejahr anlegen" })).toBeVisible();

  await page.goto("/verwaltung/gruppen?q=7b");
  const href = await page.getByRole("link", { name: "Klasse 7b", exact: true }).first().getAttribute("href");
  const groupId = href!.split("/").pop()!;
  // SEC-05: GET (z. B. ein eingebettetes Bild) setzt keinen Exportvermerk
  expect((await page.request.get(`/api/klassenbuch/archiv/${groupId}`)).status()).toBe(405);
  const res = await page.request.post(`/api/klassenbuch/archiv/${groupId}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/zip");
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect((await res.body()).subarray(0, 2).toString()).toBe("PK");
  expect((await page.request.post("/api/klassenbuch/archiv/unbekannt")).status()).toBe(404);

  await page.goto("/verwaltung/schuljahreswechsel");
  const open = page.getByRole("article", { name: "Archivexporte ohne Übergabe" });
  await expect(open).toContainText("Klasse 7b");
  await page.screenshot({ path: ".data/shots/e2e/schuljahreswechsel.png", fullPage: true });
  await open.getByRole("button", { name: "Übergabe Klasse 7b bestätigen" }).click();
  await expect(open).toHaveCount(0);

  await page.goto("/verwaltung/protokoll");
  await expect(page.getByText("Übergabe des Archivexports bestätigt").first()).toBeVisible();
  expect(errors).toEqual([]);
});
