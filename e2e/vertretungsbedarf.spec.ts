import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Vertretungsbedarf: Lehrkraft krank → offene Stunden; Klasse auf Exkursion → Freisetzungen mit Entfall; aufheben", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen");
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();

  const needs = page.getByRole("region", { name: /^Vertretungsbedarf am/ });
  await expect(needs.getByRole("list", { name: "Abwesenheiten" })).toContainText("BRA");
  await expect(needs.getByText(/^\d+ offen$/)).toBeVisible();
  const open = page.getByRole("table", { name: "Offene Stunden abwesender Lehrkräfte" });
  await expect(open.getByRole("row").filter({ hasText: "Klasse 7b" }).first()).toBeVisible();

  // Klasse 9a auf Exkursion: Stunden werden Freisetzungen, Entfall für alle
  await page.getByLabel("Klasse/Kurs fehlt").check();
  await form.getByLabel("Klasse/Kurs", { exact: true }).selectOption({ label: "Klasse 9a" });
  await form.getByLabel("Grund").selectOption({ label: "Exkursion" });
  await form.getByLabel("Ergänzung").fill("Landtag");
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByLabel("Klasse/Kurs fehlt")).toBeChecked();
  const released = page.getByRole("table", { name: "Freisetzungen" });
  await expect(released.getByText("Entfall fehlt").first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/vertretungsbedarf.png", fullPage: true });
  await page.getByRole("button", { name: "Entfall für alle eintragen" }).click();
  await expect(released.getByText("Entfall fehlt")).toHaveCount(0);
  await expect(released.getByText("Entfall eingetragen").first()).toBeVisible();

  // vom Bedarf zur Stunde: Vertretung eintragen öffnet die Stunden der Lehrkraft
  await open.getByRole("link", { name: "Vertretung eintragen" }).first().click();
  await expect(page).toHaveURL(/lehrkraft=u-jana\.brandt/);

  await page.getByRole("button", { name: "Abwesenheit BRA aufheben" }).click();
  await page.getByRole("button", { name: "Abwesenheit Klasse 9a aufheben" }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();

  // eingetragene Entfälle der 9a wieder aufheben – sonst fehlen dem nächsten Test Stunden (KRA unterrichtet freitags nur dort)
  const cancelled = page.getByRole("region", { name: /^Alle Änderungen am/ }).getByRole("button", { name: /^Aufheben: Klasse 9a / });
  for (let n = await cancelled.count(); n > 0; n--) {
    await cancelled.first().click();
    await expect(cancelled).toHaveCount(n - 1);
  }
  expect(errors).toEqual([]);
});

test("Vertretungsvorschläge mit Punkten übernehmen, Statistik zählt die Vertretung", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen");
  await page.getByLabel("Lehrkraft (z. B. erkrankt)").selectOption({ label: "KRA – Stefan Krause" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  const group = page.getByRole("group", { name: /^Vorschläge: / }).first();
  await expect(group.getByText(/Punkte$/).first()).toBeVisible();
  await expect(group).toContainText(/Randstunde|Hohlstunde|unterrichtet|hat sonst frei|Freisetzung/);
  await page.screenshot({ path: ".data/shots/e2e/vertretung-vorschlaege.png", fullPage: true });
  const first = group.getByRole("button", { name: /übernehmen/ }).first();
  const code = (await first.textContent())!.replace(" übernehmen", "").trim();
  await first.click();
  await expect(page.getByRole("table").last().getByRole("cell", { name: code }).first()).toBeVisible();

  await page.getByRole("link", { name: "Statistik" }).click();
  await expect(page.getByRole("heading", { name: "Vertretungsstatistik", level: 1 })).toBeVisible();
  const row = page.getByRole("table", { name: "Vertretungen je Lehrkraft" }).getByRole("row").filter({ hasText: code });
  await expect(row).toBeVisible();
  await page.getByRole("link", { name: "Dieser Monat" }).click();
  await expect(page).toHaveURL(/zeitraum=monat/);
  expect(errors).toEqual([]);
});
