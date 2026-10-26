import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test.describe("SP2-12 · Lehrfächer und Fachbedarf", () => {
  test("Zuweisung schlägt nur Lehrkräfte mit dem Fach vor (nach Restdeputat), andere über „alle anzeigen“ mit Warnhinweis und Bestätigung", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto("/planung/unterricht?gruppe=g-7b&neu=1");
    await page.getByLabel("Fach").selectOption({ label: "Physik" });
    await page.getByLabel("Wochenstunden").fill("1");
    const box = page.locator('[data-teacher-select="teacherId"]');
    const select = box.getByRole("combobox");

    // nur Physik-Lehrkräfte, absteigend nach Restdeputat
    await expect(select.locator('optgroup[label="unterrichten Physik"] option')).not.toHaveCount(0);
    await expect(select.locator("option", { hasText: "BRA – Jana Brandt" })).toHaveCount(0);
    const texts = await select.locator('optgroup[label="unterrichten Physik"] option').allTextContents();
    expect(texts.some((t) => t.startsWith("KLE – Tobias Kleine"))).toBe(true);
    const rest = texts.map((t) => {
      const m = /Rest ([\d,]+) Std\.|([\d,]+) Std\. über Soll|Deputat voll/.exec(t);
      if (!m) return NaN;
      return m[1] ? Number(m[1].replace(",", ".")) : m[2] ? -Number(m[2].replace(",", ".")) : 0;
    });
    expect(rest.every((r) => !Number.isNaN(r))).toBe(true);
    expect(rest).toEqual([...rest].sort((a, b) => b - a));

    // alle anzeigen: fachfremde mit Kennzeichnung
    await box.getByRole("checkbox", { name: /alle anzeigen/ }).check();
    const off = select.locator('optgroup[label="unterrichten Physik laut Stammdaten nicht"] option', { hasText: "BRA – Jana Brandt" });
    await expect(off).toHaveCount(1);
    await expect(off).toContainText("fachfremd");
    await select.selectOption("u-jana.brandt");
    await expect(box.getByRole("alert")).toContainText("BRA unterrichtet Physik laut Stammdaten nicht.");
    await page.screenshot({ path: ".data/shots/e2e/fachbedarf-zuweisung.png", fullPage: true });

    // ohne Bestätigung nicht still durchgewinkt
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText("BRA unterrichtet Physik laut Stammdaten nicht – zum Speichern „Trotzdem zuweisen“ ankreuzen").first()).toBeVisible();
    await expect(page).toHaveURL(/neu=1/);
    await expect(select).toHaveValue("u-jana.brandt");
    await box.getByRole("checkbox", { name: "Trotzdem zuweisen" }).check();
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page).not.toHaveURL(/neu=/);
    const row = page.getByRole("row").filter({ hasText: "Physik" }).filter({ has: page.getByRole("cell", { name: "BRA", exact: true }) });
    await expect(row).toHaveCount(1);

    // aufräumen
    await row.getByRole("link", { name: "Physik" }).click();
    await page.getByRole("button", { name: "Lehrauftrag löschen" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Physik" }).filter({ has: page.getByRole("cell", { name: "BRA", exact: true }) })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Fachbedarf: Planung mit Details und Pflege, Schulleitung nur Summen ohne Namen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto("/planung");
    await expect(page.locator('[data-kachel="fachbedarf"]')).toBeVisible();
    await page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Fachbedarf" }).click();
    await expect(page.getByRole("heading", { name: "Fachbedarf", level: 1 })).toBeVisible();
    const ph = page.locator('tr[data-fach="PH"]');
    await expect(ph).toBeVisible();
    await expect(ph).toContainText("KLE");
    await expect(page.locator('tr[data-prognose="PH"]')).toBeVisible();

    // Zugang Physik eintragen und wieder entfernen
    const form = page.getByRole("region", { name: "Abgänge und Zugänge" });
    await form.getByLabel("Art").selectOption("zugang");
    await form.getByLabel("Physik").check();
    await form.getByLabel("Stunden").fill("12");
    await form.getByRole("button", { name: "Eintragen" }).click();
    await expect(form.getByRole("status")).toHaveText("Eingetragen.");
    await expect(page.locator('tr[data-prognose="PH"]')).toContainText("+12");
    await form.getByRole("button", { name: /^Zugang vom .* entfernen$/ }).first().click();
    await expect(page.locator('tr[data-prognose="PH"]')).not.toContainText("+12");

    // Lehrfächer in den Stammdaten der Lehrkraft pflegen
    await page.goto("/planung/unterricht?ansicht=lehrkraefte&lehrkraft=u-frank.schulte");
    const fak = page.getByRole("form", { name: "Lehrfächer" });
    await fak.getByLabel("Chemie").check();
    await fak.getByRole("button", { name: "Lehrfächer speichern" }).click();
    await expect(fak.getByRole("status")).toHaveText("Gespeichert.");
    await expect(page.getByRole("form", { name: "Lehrfächer" }).getByLabel("Chemie")).toBeChecked();
    await page.getByRole("form", { name: "Lehrfächer" }).getByLabel("Chemie").uncheck();
    await page.getByRole("form", { name: "Lehrfächer" }).getByRole("button", { name: "Lehrfächer speichern" }).click();
    await expect(page.getByRole("form", { name: "Lehrfächer" }).getByRole("status")).toHaveText("Gespeichert.");
    expect(errors).toEqual([]);
  });

  test("Schulleitung: Fachbedarf nur aggregiert", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "petra.lindner");
    await page.goto("/planung/bedarf");
    await expect(page.getByRole("heading", { name: "Fachbedarf", level: 1 })).toBeVisible();
    await expect(page.getByText("nur Summen je Fach, ohne Namen")).toBeVisible();
    await expect(page.locator('tr[data-fach="PH"]')).toBeVisible();
    await expect(page.locator('tr[data-fach="PH"]')).not.toContainText("KLE");
    await expect(page.getByRole("heading", { name: "Abgänge und Zugänge" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Klassenzahlen speichern" })).toHaveCount(0);
    expect(errors).toEqual([]);
    // keine Planung: Unterrichtsverteilung bleibt verborgen
    expect((await page.goto("/planung/unterricht"))!.status()).toBe(404);
  });
});
