// Schulbücherei – Bestand (BU-01): Büchereiteam legt einen Titel mit Exemplaren an, ergänzt und sondert aus, prüft einen
// CSV-Import in der Vorschau; Lehrkraft ohne Teamrecht bekommt 404. Theke (BU-02): Person suchen, scannen, verlängern,
// Rückgabe nur scannen, Rückgabe mit Befund; Befunde nur für die Verwaltung.
import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

const TITLE = "Sternenstaub (E2E)";

test.describe("Bücherei", () => {
  test("BU-01: Titel anlegen, Exemplare ergänzen, aussondern, Import-Vorschau", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await login(page, "aylin.demir"); // Leitung Büchereiteam (Demo)
    await page.getByRole("link", { name: "Bücherei" }).first().click();
    // Team mit Thekenrecht landet an der Theke, der Bestand ist ein Reiter
    await expect(page).toHaveURL("/buecherei/theke");
    await page.getByRole("navigation", { name: "Bücherei" }).getByRole("link", { name: "Bestand" }).click();
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

  test("BU-02: Theke – Person wählen, scannen, verlängern, zurückbuchen, Befund", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await login(page, "aylin.demir");
    // eigenes Exemplar anlegen
    await page.goto("/buecherei/bestand");
    const form = page.getByRole("form", { name: "Titel anlegen" });
    await form.getByLabel("Titel", { exact: true }).fill("Thekenprobe (E2E)");
    await form.getByLabel("Exemplare").fill("1");
    await form.getByRole("button", { name: "Anlegen" }).click();
    await expect(page).toHaveURL(/\/buecherei\/bestand\/[0-9a-f-]+$/);
    const barcode = (await page.getByRole("table", { name: "Exemplare von Thekenprobe (E2E)" }).getByText(/^B-\d{6}-\d$/).textContent())!;

    await page.goto("/buecherei/theke");
    const scan = page.getByRole("form", { name: "Scannen" });
    const field = scan.getByLabel("Exemplar scannen");
    await expect(field).toBeFocused();
    // ohne Person: nicht ausgeliehenes Exemplar → Hinweis
    await field.fill(barcode);
    await field.press("Enter");
    await expect(scan.getByRole("alert")).toContainText("erst die Person wählen");

    // Person suchen und wählen
    const search = page.getByRole("form", { name: "Person suchen" });
    await search.getByLabel("Name oder Klasse").fill("Schäfer 7b");
    await search.getByRole("button", { name: "Suchen" }).click();
    await page.getByRole("list", { name: "Suchergebnis" }).getByRole("link", { name: /Lea Schäfer/ }).click();
    await expect(page.getByText("Ausleihe für Lea Schäfer")).toBeVisible();
    await expect(page.getByText("Keine offenen Ausleihen.")).toBeVisible();

    // Ausleihe per Scan (Hand-Scanner = Tastatur + Enter); Feld bleibt fokussiert und leer
    await field.fill(barcode.toLowerCase());
    await field.press("Enter");
    await expect(scan.getByRole("status")).toContainText(`Ausgeliehen: Thekenprobe (E2E) (${barcode}), fällig am`);
    await expect(field).toHaveValue("");
    const loans = page.getByRole("table", { name: "Offene Ausleihen von Lea Schäfer" });
    await expect(loans.getByText(barcode)).toBeVisible();

    // verlängern
    const renew = page.getByRole("form", { name: `${barcode} verlängern` });
    await renew.getByRole("button", { name: "Verlängern" }).click();
    await expect(renew.getByRole("status")).toContainText("Verlängert bis");
    await expect(loans.getByText("1-mal verlängert")).toBeVisible();

    // Rückgabe nur scannen – auch ohne gewählte Person
    await page.getByRole("link", { name: "Person abwählen" }).click();
    await expect(page).toHaveURL("/buecherei/theke");
    await field.fill(barcode);
    await field.press("Enter");
    await expect(scan.getByRole("status")).toContainText(`Zurückgebucht: Thekenprobe (E2E) (${barcode})`);

    // noch einmal ausleihen, dann mit Befund zurück
    await page.goto(`/buecherei/theke?q=${encodeURIComponent("Schäfer 7b")}`);
    await page.getByRole("list", { name: "Suchergebnis" }).getByRole("link", { name: /Lea Schäfer/ }).click();
    await expect(page.getByText("Ausleihe für Lea Schäfer")).toBeVisible();
    await field.fill(barcode);
    await field.press("Enter");
    await expect(scan.getByRole("status")).toContainText("Ausgeliehen:");
    const befund = page.getByRole("form", { name: "Rückgabe mit Befund" });
    await befund.getByLabel("Exemplarnummer").fill(barcode);
    await befund.getByLabel("Befund").fill("Umschlag eingerissen");
    await befund.getByRole("button", { name: "Mit Befund zurückbuchen" }).click();
    await expect(befund.getByRole("status")).toContainText("Zurückgebucht mit Befund");
    await page.reload();
    await expect(page.getByText("Keine offenen Ausleihen.")).toBeVisible();
    // Thekenteam sieht keine Befunde
    await expect(page.getByRole("heading", { name: "Offene Befunde" })).toHaveCount(0);
    expect(errors).toEqual([]);
    await logoutForSwitch(page);

    // Verwaltung sieht und erledigt den Befund
    await login(page, "sabine.kowalski");
    await page.goto("/buecherei/theke");
    const findings = page.getByRole("table", { name: "Rückgaben mit Befund" });
    const row = findings.getByRole("row").filter({ hasText: barcode });
    await expect(row).toContainText("Umschlag eingerissen");
    await expect(row).toContainText("Lea Schäfer (7b)");
    await row.getByRole("button", { name: `Befund ${barcode} erledigt` }).click();
    await expect(findings.getByText(barcode)).toHaveCount(0);
    await logoutForSwitch(page);
  });

  test("BU-02: Schülerin ohne Teamrecht – keine Theke (404)", async ({ page }) => {
    await login(page, "lea.schaefer");
    expect((await page.goto("/buecherei/theke"))?.status()).toBe(404);
    expect((await page.goto("/buecherei"))?.status()).toBe(404);
    await logoutForSwitch(page);
  });

  test("BU-01: Lehrkraft ohne Teamrecht sieht den Bestand nicht (404, kein Menüpunkt)", async ({ page }) => {
    await login(page, "jana.brandt");
    await expect(page.getByRole("link", { name: "Bücherei", exact: true })).toHaveCount(0);
    expect((await page.goto("/buecherei/bestand"))?.status()).toBe(404);
    await logoutForSwitch(page);
  });
});
