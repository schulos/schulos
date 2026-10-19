// Schulbücherei – Bestand (BU-01): Büchereiteam legt einen Titel mit Exemplaren an, ergänzt und sondert aus, prüft einen
// CSV-Import in der Vorschau; Lehrkraft ohne Teamrecht bekommt 404.
import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

const TITLE = "Sternenstaub (E2E)";

test.describe("Bücherei", () => {
  test("BU-01: Titel anlegen, Exemplare ergänzen, aussondern, Import-Vorschau", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await login(page, "aylin.demir"); // Leitung Büchereiteam (Demo)
    await page.getByRole("link", { name: "Bücherei" }).first().click();
    await expect(page).toHaveURL("/buecherei/bestand");
    await expect(page.getByRole("heading", { name: "Bestand", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Die Nacht im Leuchtturm" })).toBeVisible();

    // Titel mit zwei Exemplaren anlegen → Detailseite mit fortlaufenden Exemplarnummern
    const form = page.getByRole("form", { name: "Titel anlegen" });
    await form.getByLabel("Titel", { exact: true }).fill(TITLE);
    await form.getByLabel("Autor:in").fill("E. Zweiundzwanzig");
    await form.getByLabel("ISBN").fill("0-306-40615-2");
    await form.getByLabel("Exemplare").fill("2");
    await form.getByLabel("Signatur").fill("JB ZWE");
    await form.getByRole("button", { name: "Anlegen" }).click();
    await expect(page).toHaveURL(/\/buecherei\/bestand\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(page.getByText("ISBN 978-030640615-7")).toBeVisible();
    const copies = page.getByRole("table", { name: `Exemplare von ${TITLE}` });
    await expect(copies.getByText(/^B-\d{6}-\d$/)).toHaveCount(2);

    // ein weiteres Exemplar
    const add = page.getByRole("form", { name: "Exemplare hinzufügen" });
    await add.getByRole("button", { name: "Exemplare hinzufügen" }).click();
    await expect(add.getByRole("status")).toContainText(/Exemplar B-\d{6}-\d angelegt/);
    await expect(copies.getByText(/^B-\d{6}-\d$/)).toHaveCount(3);

    // das erste aussondern
    const first = copies.getByRole("row").nth(1);
    const barcode = (await first.getByText(/^B-\d{6}-\d$/).textContent())!;
    await first.getByText("ändern / aussondern").click();
    const withdraw = page.getByRole("form", { name: `Exemplar ${barcode} aussondern` });
    await withdraw.getByLabel("Grund").fill("Einband gerissen");
    await withdraw.getByRole("button", { name: "Aussondern" }).click();
    await expect(copies.getByRole("row").nth(1)).toContainText("ausgesondert");
    await expect(page.getByText("2 von 3 Exemplaren im Bestand")).toBeVisible();

    // Suche nach Exemplarnummer findet den Titel
    await page.goto(`/buecherei/bestand?q=${encodeURIComponent(barcode)}`);
    await expect(page.getByRole("link", { name: TITLE })).toBeVisible();

    // CSV-Import nur prüfen
    const imp = page.getByRole("form", { name: "Altbestand importieren" });
    await imp.getByLabel("CSV-Datei").setInputFiles({ name: "bestand.csv", mimeType: "text/csv", buffer: Buffer.from("Titel;Autor;Exemplare\nNeu A;X;2\nNeu B;Y;1\n") });
    await imp.getByRole("button", { name: "Importieren" }).click();
    await expect(imp.getByRole("status")).toContainText("Vorschau – nichts übernommen: 2 neue Titel, 0 Zeilen zu vorhandenen Titeln, 3 Exemplare");
    expect(errors).toEqual([]);
  });

  test("BU-01: Lehrkraft ohne Teamrecht sieht den Bestand nicht (404, kein Menüpunkt)", async ({ page }) => {
    await login(page, "jana.brandt");
    await expect(page.getByRole("link", { name: "Bücherei", exact: true })).toHaveCount(0);
    expect((await page.goto("/buecherei/bestand"))?.status()).toBe(404);
    await logoutForSwitch(page);
  });
});
