// Schulbücherei – Bestand (BU-01): Büchereiteam legt einen Titel mit Exemplaren an, ergänzt und sondert aus, prüft einen
// CSV-Import in der Vorschau; Lehrkraft ohne Teamrecht bekommt 404. Theke (BU-02): Person suchen, scannen, verlängern,
// Rückgabe nur scannen, Rückgabe mit Befund; Befunde nur für die Verwaltung. Ausweise (BU-07): drucken, scannen, ersetzen.
// Katalog (BU-03): suchen, vormerken, „Meine Ausleihen“, Eltern-Sicht. Mahnliste und Widget (BU-04). Etiketten und Statistik (BU-05). ISBN-Abfrage (BU-06) ohne Netz: Schalter, Hinweis, Dublette, ungültige ISBN.
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
    const field = scan.getByLabel("Ausweis oder Exemplar scannen");
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

  test("BU-07: Ausweis drucken, an der Theke scannen, ersetzen, klassenweise drucken", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await login(page, "aylin.demir");
    await page.goto(`/buecherei/theke?q=${encodeURIComponent("Schäfer 7b")}`);
    await page.getByRole("list", { name: "Suchergebnis" }).getByRole("link", { name: /Lea Schäfer/ }).click();
    await expect(page.getByText("Ausleihe für Lea Schäfer")).toBeVisible();
    await page.getByRole("button", { name: "Ausweis drucken" }).click();
    await expect(page).toHaveURL(/\/druck\/buecherei-ausweise\?person=/);
    const card = page.getByRole("region", { name: "Ausweis Lea Schäfer" });
    await expect(card.getByRole("img", { name: /^Strichcode K-/ })).toBeVisible();
    const code = (await card.getByText(/^K-[0-9A-Z]{10}$/).textContent())!;

    // Ausweis-Scan wählt die Person
    await page.goto("/buecherei/theke");
    const field = page.getByRole("form", { name: "Scannen" }).getByLabel("Ausweis oder Exemplar scannen");
    await field.fill(code);
    await field.press("Enter");
    await expect(page).toHaveURL(/person=u-lea\.schaefer/);
    await expect(page.getByText("Ausleihe für Lea Schäfer")).toBeVisible();

    // Verlust: neuer Code, der alte gilt nicht mehr
    await page.getByRole("button", { name: "Ausweis ersetzen (Verlust)" }).click();
    await expect(page).toHaveURL(/\/druck\/buecherei-ausweise\?person=/);
    const neu = (await page.getByRole("region", { name: "Ausweis Lea Schäfer" }).getByText(/^K-[0-9A-Z]{10}$/).textContent())!;
    expect(neu).not.toBe(code);
    await page.goto("/buecherei/theke");
    await field.fill(code);
    await field.press("Enter");
    await expect(page.getByRole("form", { name: "Scannen" }).getByRole("alert")).toContainText("Ausweis unbekannt");

    // klassenweise
    await page.getByRole("navigation", { name: "Bücherei" }).getByRole("link", { name: "Ausweise" }).click();
    await expect(page).toHaveURL("/buecherei/ausweise");
    await page.getByRole("button", { name: "Ausweise Klasse 7b drucken" }).click();
    await expect(page).toHaveURL(/\/druck\/buecherei-ausweise\?klasse=g-7b/);
    await expect(page.getByRole("region", { name: /^Ausweis / })).toHaveCount(25);
    await page.getByRole("link", { name: "Etiketten 62 × 29 mm" }).click();
    await expect(page).toHaveURL(/format=etikett/);
    await expect(page.getByRole("region", { name: "Ausweis Lea Schäfer" }).getByText(neu)).toBeVisible();
    expect(errors).toEqual([]);
    await logoutForSwitch(page);
  });

  test("BU-02: Schülerin ohne Teamrecht – keine Theke (404), Einstieg ist der Katalog", async ({ page }) => {
    await login(page, "lea.schaefer");
    expect((await page.goto("/buecherei/theke"))?.status()).toBe(404);
    expect((await page.goto("/buecherei/ausweise"))?.status()).toBe(404);
    await page.goto("/buecherei");
    await expect(page).toHaveURL("/buecherei/katalog");
    await logoutForSwitch(page);
  });

  test("BU-01: Lehrkraft ohne Teamrecht sieht den Bestand nicht (404), nur Katalog und Meine Ausleihen", async ({ page }) => {
    await login(page, "jana.brandt");
    await page.getByRole("link", { name: "Bücherei", exact: true }).first().click();
    await expect(page).toHaveURL("/buecherei/katalog");
    const nav = page.getByRole("navigation", { name: "Bücherei" });
    await expect(nav.getByRole("link")).toHaveText(["Katalog", "Meine Ausleihen"]);
    expect((await page.goto("/buecherei/bestand"))?.status()).toBe(404);
    await logoutForSwitch(page);
  });

  test("BU-04: Widget und Mahnliste fürs Team (mit Mahnstufe), Lehrkraft ohne Teamrecht 404", async ({ page }) => {
    const errors = collectErrors(page);
    const FILM = "Reise zum Mond (Dokumentation)";
    await login(page, "aylin.demir"); // Lehrkraft, Leitung Büchereiteam
    await page.goto("/");
    const widget = page.locator('[data-widget="buecherei.mahnliste"]');
    await expect(widget).toContainText("überfällig");
    await expect(widget).toContainText("2. Mahnung");
    await widget.getByRole("link", { name: "Zur Mahnliste" }).click();
    await expect(page).toHaveURL("/buecherei/mahnliste");
    await expect(page.getByRole("heading", { name: "Mahnliste" })).toBeVisible();
    // Demo: der Film ist seit gut zwei Wochen überfällig und zweimal gemahnt
    const row = page.getByRole("table", { name: "Überfällige Ausleihen" }).getByRole("row").filter({ hasText: FILM });
    await expect(row).toContainText("2. Mahnung");
    await expect(row).toContainText("16 Tage");
    // von der Mahnliste zur Person an der Theke
    await row.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/buecherei\/theke\?person=/);
    await expect(page.getByRole("heading", { name: "Offene Ausleihen" })).toBeVisible();
    await expect(page.getByText("2. Mahnung")).toHaveCount(0); // die Theke zeigt keine Mahnstufen
    expect(errors).toEqual([]);
    await logoutForSwitch(page);

    await login(page, "jana.brandt");
    expect((await page.goto("/buecherei/mahnliste"))?.status()).toBe(404);
    await page.goto("/");
    await expect(page.locator('[data-widget="buecherei.mahnliste"]')).toHaveCount(0);
    await logoutForSwitch(page);
  });

  test("BU-03: Katalog, Vormerkung, Meine Ausleihen, Eltern-Sicht", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    const FILM = "Reise zum Mond (Dokumentation)";
    await login(page, "lea.schaefer");
    await page.getByRole("link", { name: "Bücherei", exact: true }).first().click();
    await expect(page).toHaveURL("/buecherei/katalog");
    const search = page.getByRole("form", { name: "Katalog durchsuchen" });
    await search.getByLabel("Suche").fill("Raumfahrt");
    await search.getByRole("button", { name: "Suchen" }).click();
    const list = page.getByRole("table", { name: "Titel im Katalog" });
    // Demo: einziges Exemplar ausgeliehen und schon einmal vorgemerkt – ohne Namen
    await expect(list.getByRole("row").filter({ hasText: FILM })).toContainText("1 Vormerkung");
    await list.getByRole("link", { name: FILM }).click();
    await expect(page.getByRole("heading", { name: FILM })).toBeVisible();
    await expect(page.getByRole("table", { name: `Exemplare von ${FILM}` })).toContainText("ausgeliehen bis");
    const reserve = page.getByRole("form", { name: "Vormerken" });
    await reserve.getByRole("button", { name: "Vormerken" }).click();
    // nach dem Vormerken zeigt die Seite den Platz in der Reihe statt des Knopfs
    await expect(page.getByText("du bist auf Platz 2").first()).toBeVisible();
    await page.reload();
    await expect(page.getByText("du bist auf Platz 2").first()).toBeVisible();
    await expect(page.getByRole("form", { name: "Vormerken" })).toHaveCount(0);

    await page.getByRole("link", { name: "← Katalog" }).click();
    await page.getByRole("navigation", { name: "Bücherei" }).getByRole("link", { name: "Meine Ausleihen" }).click();
    await expect(page).toHaveURL("/buecherei/meine");
    const res = page.getByRole("table", { name: "Vormerkungen von mir" });
    await expect(res.getByRole("row").filter({ hasText: FILM })).toContainText("Platz 2 in der Reihe");
    expect(errors).toEqual([]);
    await logoutForSwitch(page);

    // Eltern: nur lesend, ohne Katalog
    await login(page, "daniela.schaefer");
    await page.getByRole("link", { name: "Bücherei", exact: true }).first().click();
    await expect(page).toHaveURL("/buecherei/meine");
    await expect(page.getByRole("heading", { name: "Ausleihen meiner Kinder" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Vormerkungen von Lea Schäfer" })).toContainText(FILM);
    await expect(page.getByRole("button", { name: "Löschen" })).toHaveCount(0);
    expect((await page.goto("/buecherei/katalog"))?.status()).toBe(404);
    await logoutForSwitch(page);

    // Vormerkung wieder löschen
    await login(page, "lea.schaefer");
    await page.goto("/buecherei/meine");
    const cancel = page.getByRole("form", { name: `Vormerkung ${FILM} löschen` });
    await cancel.getByRole("button", { name: "Löschen" }).click();
    await expect(page.getByRole("table", { name: "Vormerkungen von mir" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("table", { name: "Vormerkungen von mir" })).toHaveCount(0);
    await logoutForSwitch(page);
  });
  test("BU-05: Etiketten aus der Warteschlange drucken und markieren, Testseite, Statistik ohne Personen", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await login(page, "aylin.demir");
    await page.goto("/buecherei/etiketten");
    await expect(page.getByRole("heading", { name: "Etiketten", exact: true })).toBeVisible();
    // Demo: Brettspiel und Film warten auf ein Etikett
    const queue = page.getByRole("table", { name: "Exemplare in der Druckwarteschlange" });
    await expect(queue.getByRole("row").filter({ hasText: "Brückenbauer (Brettspiel)" })).toBeVisible();
    const form = page.getByRole("form", { name: "Warteschlange drucken" });
    await form.getByLabel("Vorlage").selectOption("a4-3x8");
    await form.getByLabel("Startposition").fill("4");
    await form.getByRole("button", { name: "Druckansicht öffnen" }).click();
    await expect(page).toHaveURL(/\/druck\/buecherei-etiketten\?quelle=warteschlange/);
    await expect(page.getByText(/ab Position 4/)).toBeVisible();
    const sheet = page.getByRole("region", { name: "Bogen 1" });
    await expect(sheet.getByRole("img", { name: /^Strichcode B-\d{6}-\d$/ }).first()).toBeVisible();
    await expect(sheet.getByText("SP BRU")).toBeVisible();
    // Etikettendrucker: ein Etikett je Seite
    await page.getByRole("link", { name: "Etikettendrucker 62 × 29 mm" }).click();
    await expect(page.getByRole("region", { name: "Etikett 1" })).toBeVisible();
    await page.getByRole("form", { name: "Als gedruckt markieren" }).getByRole("button").click();
    await expect(page).toHaveURL(/\/buecherei\/etiketten\?gedruckt=\d+/);
    await expect(page.getByRole("status")).toContainText("als gedruckt markiert");
    await expect(page.getByRole("table", { name: "Exemplare in der Druckwarteschlange" }).getByText("Brückenbauer (Brettspiel)")).toHaveCount(0);
    // Testseite: Rahmen mit Nummern
    await page.getByRole("link", { name: "Testseite A4-Bogen 4 × 10 (52,5 × 29,7 mm)" }).click();
    await expect(page.getByRole("region", { name: "Bogen 1" }).getByText("40", { exact: true })).toBeVisible();

    // Einzeletikett aus dem Bestand
    await page.goto("/buecherei/bestand?q=Atlas");
    await page.getByRole("link", { name: "Atlas der Welt" }).click();
    await page.getByText("ändern / aussondern").first().click();
    await page.getByRole("link", { name: /^Etikett B-\d{6}-\d drucken$/ }).click();
    await expect(page.getByRole("region", { name: "Etikett 1" }).getByText("NS ATL")).toBeVisible();

    // Statistik: Monate, nie ausgeliehen, Aussonderungsvorschläge – ohne Namen
    await page.goto("/buecherei/statistik");
    await expect(page.getByRole("heading", { name: "Statistik", exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Ausleihen je Monat und Medienart" }).getByRole("row")).toHaveCount(14);
    await expect(page.getByRole("table", { name: "Nie ausgeliehene Titel" }).getByText("Atlas der Welt")).toBeVisible();
    const sug = page.getByRole("table", { name: "Aussonderungsvorschläge" });
    await expect(sug.getByRole("row").filter({ hasText: "Vulkane und Erdbeben" })).toContainText("Zustand schlecht");
    await expect(page.locator("body")).not.toContainText("Schäfer");
    expect(errors).toEqual([]);
    await logoutForSwitch(page);

    await login(page, "jana.brandt");
    expect((await page.goto("/buecherei/statistik"))?.status()).toBe(404);
    expect((await page.goto("/buecherei/etiketten"))?.status()).toBe(404);
    expect((await page.goto("/druck/buecherei-etiketten?quelle=warteschlange"))?.status()).toBe(404);
    await logoutForSwitch(page);
  });
  test("BU-06: ISBN-Abfrage ab Werk aus; eingeschaltet mit Hinweis „Externer Dienst“, Dublette ohne Anfrage nach außen", async ({ browser }) => {
    test.setTimeout(90_000);
    const SETTING = "ISBN-Abfrage bei Bibliothekskatalogen";
    const admin = await (await browser.newContext()).newPage();
    const team = await (await browser.newContext()).newPage();
    const errors = collectErrors(team);
    await login(admin, "admin");
    await login(team, "aylin.demir");

    // ab Werk aus: keine Karte
    await team.goto("/buecherei/bestand");
    await expect(team.getByRole("heading", { name: "Per ISBN nachschlagen" })).toHaveCount(0);

    const settings = async (value: "0" | "1") => {
      await admin.goto("/verwaltung/rechte");
      const select = admin.getByRole("region", { name: "Einstellungen Bücherei" }).getByLabel(SETTING);
      await expect(select).toHaveValue(value === "1" ? "0" : "1");
      await select.selectOption(value);
      await admin.reload();
      await expect(admin.getByRole("region", { name: "Einstellungen Bücherei" }).getByLabel(SETTING)).toHaveValue(value);
    };
    await settings("1");
    try {
      await team.goto("/buecherei/bestand");
      await expect(team.getByRole("heading", { name: "Per ISBN nachschlagen" })).toBeVisible();
      await expect(team.getByText("Externer Dienst:")).toBeVisible();
      await expect(team.getByText(/services\.dnb\.de/)).toBeVisible();
      // GATE BU1: ab Werk nur die deutschen Kataloge – Open Library (außerhalb der EU) ist nicht dabei
      await expect(team.getByText(/openlibrary\.org/)).toHaveCount(0);
      const form = team.getByRole("form", { name: "ISBN nachschlagen" });
      // ungültige Prüfziffer → Fehler am Feld, nichts geht raus
      await form.getByLabel("ISBN").fill("978-3-00-000001-1");
      await form.getByRole("button", { name: "Nachschlagen" }).click();
      await expect(form.getByText("keine gültige ISBN (Prüfziffer)")).toBeVisible();
      // Dublette im eigenen Bestand → Hinweis mit Link, ohne externe Anfrage
      await form.getByLabel("ISBN").fill("978-3-00-000001-0");
      await form.getByRole("button", { name: "Nachschlagen" }).click();
      await expect(team.getByRole("status").filter({ hasText: "gehört schon zu „Die Nacht im Leuchtturm“" })).toBeVisible();
      await team.getByRole("link", { name: "dort weitere Exemplare anlegen" }).click();
      await expect(team.getByRole("heading", { name: "Die Nacht im Leuchtturm" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await settings("0"); // gemeinsame E2E-Datenbank: zurück auf die Vorgabe
    }
    await admin.context().close();
    await team.context().close();
  });
});
