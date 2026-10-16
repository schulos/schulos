import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// Q5-02: Hausaufgaben aus dem Klassenbuch für Schüler:innen (Heute + Kursraum), für Eltern nur per Moduleinstellung.
// Welche Hausaufgaben gerade fällig sind, hängt vom Tag des Laufs ab (Demo-Klassenbuch der letzten Schultage) – das prüfen
// die Service-Tests (klassenbuch/homework.test.ts); hier Sichtbarkeit und Schalter.
const SETTING = "Hausaufgaben für Eltern sichtbar";

test("Hausaufgaben: Schülerin auf Heute und im Kursraum, Eltern erst nach Moduleinstellung (Q5-02)", async ({ browser }) => {
  const lea = await (await browser.newContext()).newPage();
  const mother = await (await browser.newContext()).newPage();
  const admin = await (await browser.newContext()).newPage();
  const errorsOf = [collectErrors(lea), collectErrors(mother), collectErrors(admin)];

  await login(lea, "lea.schaefer");
  await expect(lea.getByRole("article", { name: "Hausaufgaben" })).toBeVisible();
  await lea.goto("/kurse/g-7b");
  await expect(lea.getByRole("article", { name: "Hausaufgaben" })).toBeVisible();

  // Vorgabe aus: Eltern sehen kein Widget
  await login(mother, "daniela.schaefer");
  await expect(mother.getByRole("region", { name: /Tagesleiste/ }).first()).toBeVisible();
  await expect(mother.getByRole("article", { name: "Hausaufgaben" })).toHaveCount(0);

  await login(admin, "admin");
  await admin.goto("/verwaltung/rechte");
  const select = admin.getByRole("region", { name: "Einstellungen Klassenbuch" }).getByLabel(SETTING);
  await select.selectOption({ label: "bis Jahrgang 7" });
  await expect(select).toHaveValue("7");
  // gespeichert (die Auswahl speichert sofort) – erst dann bei den Eltern nachsehen
  await admin.reload();
  await expect(admin.getByRole("region", { name: "Einstellungen Klassenbuch" }).getByLabel(SETTING)).toHaveValue("7");
  await mother.reload();
  const card = mother.getByRole("article", { name: "Hausaufgaben" });
  await expect(card).toBeVisible();

  // zurück auf die Vorgabe (gemeinsame E2E-Datenbank)
  await admin.reload();
  await admin.getByRole("region", { name: "Einstellungen Klassenbuch" }).getByLabel(SETTING).selectOption({ label: "aus" });
  await expect(admin.getByRole("region", { name: "Einstellungen Klassenbuch" }).getByLabel(SETTING)).toHaveValue("0");
  await admin.reload();
  await expect(admin.getByRole("region", { name: "Einstellungen Klassenbuch" }).getByLabel(SETTING)).toHaveValue("0");
  await mother.reload();
  await expect(mother.getByRole("article", { name: "Hausaufgaben" })).toHaveCount(0);

  for (const e of errorsOf) expect(e).toEqual([]);
  for (const p of [lea, mother, admin]) await p.context().close();
});
