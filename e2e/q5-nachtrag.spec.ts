import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test.describe("Q5-Nachtrag", () => {
  test("Q5-01: Sekretariat nimmt eine Telefon-Krankmeldung auf → Klassenleitung sieht „gemeldet“ und entscheidet", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);

    await login(page, "sabine.kowalski");
    await page.goto("/abwesenheiten");
    await expect(page).toHaveURL(/\/abwesenheiten$/);
    const card = page.getByRole("heading", { name: /Telefonische Krankmeldung/ });
    await expect(card).toBeVisible();

    // eine Schülerin/ein Schüler der 7b (nicht Lea – deren Meldung nutzt abwesenheiten.spec.ts)
    const labels = await page.getByLabel("Schüler:in", { exact: true }).locator("option").allTextContents();
    const label = labels.find((l) => l.includes("(Klasse 7b)") && !l.startsWith("Lea"));
    expect(label, "Schüler:in der 7b im Auswahlfeld").toBeTruthy();
    const name = label!.replace(/ \(Klasse 7b\)$/, "");
    await page.getByLabel("Schüler:in", { exact: true }).selectOption({ label: label! });
    await page.getByLabel("krank", { exact: true }).check();
    // Telefon-Formular schickt den Weg mit – so bleibt es auch für Entscheidungsberechtigte bei „gemeldet“ (Code-Review Gate 4a M3)
    await expect(page.locator('form input[type="hidden"][name="channel"]')).toHaveValue("telefon");
    await page.getByRole("button", { name: "Krankmeldung aufnehmen", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Aufgenommen" })).toContainText("die Klassenleitung ist benachrichtigt und entscheidet");
    await page.screenshot({ path: ".data/shots/e2e/abwesenheit-telefon.png", fullPage: true });

    // Klassenleitung: Gong, Meldung mit Status „gemeldet“ (offen), dann entscheiden
    await logoutForSwitch(page);
    await login(page, "jana.brandt");
    await page.getByRole("button", { name: /Gong/ }).click();
    await expect(page.getByText(`Abwesenheit gemeldet: ${name}`).first()).toBeVisible();
    await page.goto("/abwesenheiten");
    await expect(page).toHaveURL(/\/abwesenheiten$/);
    const offen = page.getByRole("region", { name: /Offene Meldungen/ }).or(page.locator("section", { hasText: "Offene Meldungen" })).first();
    await expect(offen).toContainText(name);
    await page.getByRole("button", { name: `Entschuldigen: ${name}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Entschuldigen: ${name}`, exact: true })).toHaveCount(0);
    await expect(page.locator("section", { hasText: "Verlauf" }).first()).toContainText(name);

    expect(errors).toEqual([]);
    // Schüler:innen sehen nur die eigenen Fehlzeiten (Q5-13), kein Telefon-Formular, keine Meldungen anderer
    await logoutForSwitch(page);
    await login(page, "lea.schaefer");
    await page.goto("/abwesenheiten");
    await expect(page.getByRole("heading", { name: "Meine Fehlzeiten", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Telefonische Krankmeldung/ })).toHaveCount(0);
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test("Q5-08: Hausmeisterei (Rolle Personal) sieht die Raumbelegung, kann aber keine Sperre anlegen", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "klaus.berger");
    await page.getByRole("link", { name: "Räume", exact: true }).first().click();
    await expect(page).toHaveURL(/\/stundenplan\/raeume/);
    await expect(page.getByRole("heading", { name: "Räume", exact: true })).toBeVisible();
    // ohne Buchungsrecht kein „Buchen“ (führte auf eine 404, Code-Review Gate 4a N8)
    await expect(page.getByRole("link", { name: "Buchen", exact: true })).toHaveCount(0);

    await page.goto("/stundenplan/raeume?ansicht=belegung");
    await expect(page).toHaveURL(/ansicht=belegung/);
    await expect(page.getByRole("link", { name: "Belegung", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("table").first()).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/raeume-hausmeisterei.png", fullPage: true });

    // keine Sperrungen-Ansicht, kein Sperrformular
    await expect(page.getByRole("link", { name: "Sperrungen", exact: true })).toHaveCount(0);
    await page.goto("/stundenplan/raeume?ansicht=sperrungen");
    await expect(page).toHaveURL(/ansicht=sperrungen/);
    await expect(page.getByRole("form", { name: "Raum sperren" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Raum sperren" })).toHaveCount(0);

    expect(errors).toEqual([]); // vor dem absichtlichen 404 unten
    // Schüler:innen bleiben ausgesperrt
    await logoutForSwitch(page);
    await login(page, "lea.schaefer");
    expect((await page.goto("/stundenplan/raeume"))?.status()).toBe(404);
  });

  test("Q5-08b: Hausmeisterei sieht Buchungen nur lesend und „Heute im Haus“", async ({ page, browser }) => {
    const errors = collectErrors(page);
    await login(page, "klaus.berger");
    await expect(page.getByRole("article", { name: "Heute im Haus" })).toBeVisible();
    await page.getByRole("link", { name: "Buchungen", exact: true }).first().click();
    await expect(page).toHaveURL(/\/buchungen/);
    await expect(page.getByRole("heading", { name: "Buchungen", level: 1 })).toBeVisible();
    await expect(page.getByText("Nur lesen – gebucht wird von Lehrkräften und Verwaltung.")).toBeVisible();
    // keine Knöpfe zum Buchen/Stornieren, keine eigene Buchungsliste, keine Ressourcenverwaltung
    await expect(page.getByRole("button", { name: /^Buchen:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Stornieren:/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Meine Buchungen" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Ressourcen verwalten" })).toHaveCount(0);
    expect(errors).toEqual([]);

    // Lehrkraft bucht weiterhin; Schülerin hat keinen Zugang
    const ctx = await browser.newContext();
    const lea = await ctx.newPage();
    await login(lea, "lea.schaefer");
    expect((await lea.goto("/buchungen"))?.status()).toBe(404);
    await ctx.close();
  });
});
