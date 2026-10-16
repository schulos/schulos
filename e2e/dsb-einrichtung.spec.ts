import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// DS-12: Datenschutz-Einrichtung durch die Schule. Hinweis auf Heute, bis Bestätigung und alle Punkte der DSB-Checkliste
// erledigt sind; Nachweis als JSON mit allen Löschfristen; Sekretariat ohne Datenschutzrecht kommt nicht hinein.
// (Dateiname bewusst nach datenschutz.spec.ts: jene prüft die Datenschutzhinweise noch ohne Angaben der Schule.)
test("Datenschutz-Einrichtung: Bestätigung, Punkte abhaken, Hinweis verschwindet, Nachweis als JSON", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await login(page, "petra.lindner");
  await expect(page.locator('[data-widget="heute.offen"] [data-open-item="verwaltung:datenschutz"]')).toContainText("Datenschutz-Einrichtung");

  await page.goto("/verwaltung/datenschutz/angaben");
  const texts = page.getByRole("form", { name: "Angaben der Schule" });
  await texts.getByLabel("Verantwortliche Stelle").fill("Gesamtschule am Lindenhof\nLindenweg 1, 40000 Musterstadt");
  await texts.getByLabel("Datenschutzbeauftragte:r").fill("Datenschutz Schulamt, dsb@schulamt.example");
  await texts.getByRole("button", { name: "Speichern" }).click();
  await expect(texts.getByRole("status")).toHaveText("Gespeichert.");

  await page.goto("/verwaltung/datenschutz");
  await page.getByRole("link", { name: "Einrichtung", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Datenschutz-Einrichtung", level: 1 })).toBeVisible();
  await expect(page.locator("[data-setup-state]")).toHaveAttribute("data-setup-state", "offen");

  const confirm = page.getByRole("form", { name: "Bestätigung als Verantwortliche" });
  await confirm.getByRole("button", { name: "Bestätigen" }).click();
  await expect(confirm.getByRole("alert")).toContainText("Bestätigung ankreuzen");
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page.getByText("bestätigt", { exact: true })).toBeVisible();

  // Moduleinstellungen stehen beim Thema mit aktuellem Wert und Vorgabe
  await expect(page.locator('[data-topic="beratung"]')).toContainText("Chats mit der Schulsozialarbeit");
  const forms = page.getByRole("form", { name: /^Status: / });
  const n = await forms.count();
  expect(n).toBeGreaterThan(10);
  for (let i = 0; i < n; i++) {
    const f = forms.nth(i);
    await f.getByLabel("Status").selectOption("vorgabe");
    await f.getByRole("button", { name: "Speichern" }).click();
    await expect(f.getByRole("status")).toHaveText("Gespeichert.");
  }
  await page.reload();
  await expect(page.locator("[data-setup-state]")).toHaveAttribute("data-setup-state", "fertig");
  await page.screenshot({ path: ".data/shots/e2e/datenschutz-einrichtung.png", fullPage: true });

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Nachweis als JSON" }).click()]);
  const json = JSON.parse(readFileSync((await download.path())!, "utf8")) as { erledigt: boolean; themen: unknown[]; loeschfristen: { tabelle: string }[] };
  expect(json.erledigt).toBe(true);
  expect(json.themen.length).toBe(n);
  expect(json.loeschfristen.map((f) => f.tabelle)).toContain("chat_messages");

  await page.goto("/druck/datenschutz-einrichtung");
  await expect(page.getByRole("heading", { name: /Datenschutz-Konfiguration/ })).toBeVisible();
  await page.goto("/");
  await expect(page.locator('[data-open-item="verwaltung:datenschutz"]')).toHaveCount(0);
  expect(errors).toEqual([]);

  await page.context().clearCookies();
  await login(page, "sabine.kowalski");
  expect((await page.goto("/verwaltung/datenschutz/einrichtung"))?.status()).toBe(404);
  const res = await page.request.post("/api/verwaltung/datenschutz-einrichtung");
  expect(res.status()).toBe(403);
});
