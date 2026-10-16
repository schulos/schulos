import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

const SHOTS = ".data/shots/e2e";
// echtes PNG (SchulOS-Zeichen) als „Foto“ des Mangels
const PHOTO = { name: "beamer.png", mimeType: "image/png", buffer: readFileSync("public/icon.png") };
const TITLE = "Beamer defekt (E2E)";
const ROOM = "106"; // hat Unterricht (Demo-Stundenplan)

test.describe("Gebäude & Technik", () => {
  test("Lehrkraft meldet Mangel mit Foto → Hausmeister sieht ihn im Board, nimmt an, sperrt den Raum → Vertretungsbedarf → erledigt beendet die Sperre", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);

    // 1. Lehrkraft meldet aus dem Raum-Kontext (vorbelegter Raum) mit Foto
    await login(page, "jana.brandt");
    await page.goto(`/gebaeude/melden?raum=${ROOM}`);
    const form = page.getByRole("form", { name: "Mangel melden" });
    await expect(form.getByLabel("Raum")).toHaveValue(ROOM);
    await form.getByLabel("Was ist kaputt?").fill(TITLE);
    await form.getByLabel("Kategorie").selectOption({ label: "IT/Medien" });
    await form.getByLabel("Beschreibung").fill("Bild flackert und geht nach 5 Minuten aus.");
    await form.getByLabel(/^Fotos/).setInputFiles(PHOTO);
    await form.getByRole("button", { name: "Mangel melden" }).click();
    await expect(page).toHaveURL(/\/gebaeude\/[0-9a-f-]+\?gemeldet=1$/);
    await expect(page.getByRole("status")).toContainText("Gemeldet");
    const ticketUrl = page.url().replace(/\?.*$/, "");
    const number = /M-\d{4}-\d{4}/.exec((await page.getByText(/^Gebäude & Technik · M-/).textContent()) ?? "")?.[0];
    expect(number).toBeTruthy();
    const img = page.getByRole("list", { name: "Fotos" }).getByRole("img").first();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    // Foto-Route: Typ fest, nosniff, Sandbox
    const src = (await img.getAttribute("src"))!;
    const res = await page.request.get(src);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-security-policy"]).toContain("sandbox");
    await page.screenshot({ path: `${SHOTS}/gebaeude-meldung.png`, fullPage: true });
    // Melder:in kann den Status nicht ändern
    await expect(page.getByRole("form", { name: "Status ändern" })).toHaveCount(0);

    // 2. Hausmeister: Meldung im Board unter „Neu“, annehmen, Raum sperren
    await logoutForSwitch(page);
    await login(page, "klaus.berger");
    await page.getByRole("link", { name: "Gebäude & Technik" }).first().click();
    await expect(page).toHaveURL("/gebaeude");
    const neu = page.getByRole("list", { name: "Neu" });
    await expect(neu.getByRole("link", { name: `${number}: ${TITLE}` })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/gebaeude-board.png`, fullPage: true });
    await neu.getByRole("link", { name: `${number}: ${TITLE}` }).click();
    await expect(page).toHaveURL(ticketUrl);
    const status = page.getByRole("form", { name: "Status ändern" });
    await status.getByLabel("Kommentar zum Statuswechsel").fill("Schaue ich mir in der 2. Pause an");
    await status.getByRole("button", { name: "Annehmen" }).click();
    await expect(status.getByRole("status")).toContainText("Status geändert.");
    await expect(page.getByRole("list", { name: "Verlauf" })).toContainText("Status: Neu → Angenommen");
    await expect(page.getByRole("form", { name: "Zuweisen" }).getByLabel("Bearbeitet von")).toHaveValue("u-klaus.berger");

    const block = page.getByRole("form", { name: "Raum sperren" });
    await block.getByLabel("bis Tag").fill(new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10));
    await block.getByRole("button", { name: `Raum ${ROOM} sperren` }).click();
    await expect(page.getByRole("article", { name: "Raumsperre" })).toContainText(`Raum ${ROOM} gesperrt:`);
    await expect(page.getByRole("list", { name: "Verlauf" })).toContainText(`Raum ${ROOM} gesperrt`);
    await page.screenshot({ path: `${SHOTS}/gebaeude-raumsperre.png`, fullPage: true });

    // 3. Stundenplan: Sperre mit Grund „Defekt“ und Verweis auf die Meldung, betroffene Stunden als Vertretungsbedarf
    await logoutForSwitch(page);
    await login(page, "sabine.kowalski");
    await page.goto("/stundenplan/raeume?ansicht=sperrungen");
    await expect(page.getByRole("table", { name: "Raumsperrungen" }).getByRole("row").filter({ hasText: ROOM })).toContainText(`Defekt · ${number}`);
    await expect(page.getByRole("table", { name: "Stunden in gesperrten Räumen" }).getByRole("row").filter({ hasText: ROOM }).first()).toBeVisible();

    // 4. Hausmeister: erledigt → Sperre endet (beginnt heute → fällt ganz weg)
    await logoutForSwitch(page);
    await login(page, "klaus.berger");
    await page.goto(ticketUrl);
    const done = page.getByRole("form", { name: "Status ändern" });
    await expect(done.getByLabel("Bei „Erledigt“ die Raumsperre ab heute beenden")).toBeChecked();
    await done.getByRole("button", { name: "Erledigt" }).click();
    await expect(page.getByRole("article", { name: "Raumsperre" })).toContainText("Raum ist nicht gesperrt.");
    await expect(page.getByRole("list", { name: "Verlauf" })).toContainText(`Sperre von Raum ${ROOM} beendet`);

    // 5. Lehrkraft sieht den Abschluss (Gong + Status)
    await logoutForSwitch(page);
    await login(page, "jana.brandt");
    await page.goto(ticketUrl);
    await expect(page.getByRole("list", { name: "Verlauf" })).toContainText("Status: Angenommen → Erledigt");
    expect(errors).toEqual([]);
  });

  test("Hausmeister (Rolle Personal) sieht keine Schülerdaten; Schüler:innen melden per Vorgabe nicht", async ({ page }) => {
    await login(page, "klaus.berger");
    await page.goto("/adressbuch?q=lea.schaefer");
    await expect(page.getByText("Nichts gefunden für „lea.schaefer“")).toBeVisible();
    await page.goto("/adressbuch?q=brandt");
    await expect(page.getByText("Jana Brandt").first()).toBeVisible();
    expect((await page.goto("/adressbuch/person/u-lea.schaefer"))?.status()).toBe(404);
    expect((await page.goto("/adressbuch/gruppe/g-7b"))?.status()).toBe(404);
    expect((await page.goto("/klassenbuch"))?.status()).toBe(404);

    await logoutForSwitch(page);
    await login(page, "lea.schaefer");
    await expect(page.getByRole("link", { name: "Gebäude & Technik" })).toHaveCount(0);
    expect((await page.goto("/gebaeude/melden"))?.status()).toBe(404);
  });
});
