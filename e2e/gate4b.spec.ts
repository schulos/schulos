import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// Gate 4b (P4-19): Meldung mit Foto bis zum Abschluss mit Gong auf beiden Seiten; Prüfungen mit Fristen, Erinnerung,
// Mangel → Meldung, Protokoll-PDF; Verwaltung, Anlagen-Import, Wartung, Prüfliste und CSV ohne Namen.
const SHOTS = ".data/shots/e2e";
const PHOTO = { name: "steckdose.png", mimeType: "image/png", buffer: readFileSync("public/icon.png") };
const PDF = { name: "protokoll.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n") };
const FAKE_PDF = { name: "kein.pdf", mimeType: "application/pdf", buffer: readFileSync("public/icon.png") };
const TITLE = "Steckdose lose (Gate 4b)";
const ROOM = "105";

async function openGong(page: Page) {
  await page.getByRole("button", { name: /Gong/ }).click();
}

test.describe("Gate 4b – Gebäude & Technik", () => {
  test("Lehrkraft meldet mit Foto → Hausmeister bekommt Gong, nimmt an, sperrt den Raum, erledigt → Lehrkraft bekommt Gong", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await login(page, "jana.brandt");
    await page.goto(`/gebaeude/melden?raum=${ROOM}`);
    const form = page.getByRole("form", { name: "Mangel melden" });
    await form.getByLabel("Was ist kaputt?").fill(TITLE);
    await form.getByLabel("Kategorie").selectOption({ label: "Haustechnik" });
    await form.getByLabel(/^Fotos/).setInputFiles(PHOTO);
    await form.getByRole("button", { name: "Mangel melden" }).click();
    await expect(page).toHaveURL(/\/gebaeude\/[0-9a-f-]+\?gemeldet=1$/);
    const ticketUrl = page.url().replace(/\?.*$/, "");
    await expect(page.getByRole("list", { name: "Fotos" }).getByRole("img")).toHaveCount(1);

    await logoutForSwitch(page);
    await login(page, "klaus.berger");
    await openGong(page);
    await expect(page.getByText(`Neue Meldung: ${TITLE}`).first()).toBeVisible();
    await page.goto(ticketUrl);
    const status = page.getByRole("form", { name: "Status ändern" });
    await status.getByRole("button", { name: "Annehmen" }).click();
    await expect(status.getByRole("status")).toContainText("Status geändert.");
    await page.getByRole("form", { name: "Raum sperren" }).getByRole("button", { name: `Raum ${ROOM} sperren` }).click();
    await expect(page.getByRole("article", { name: "Raumsperre" })).toContainText(`Raum ${ROOM} gesperrt:`);
    await page.getByRole("form", { name: "Status ändern" }).getByRole("button", { name: "Erledigt" }).click();
    await expect(page.getByRole("article", { name: "Raumsperre" })).toContainText("Raum ist nicht gesperrt.");

    await logoutForSwitch(page);
    await login(page, "jana.brandt");
    await openGong(page);
    await expect(page.getByText("Deine Meldung: Angenommen").first()).toBeVisible();
    await expect(page.getByText("Deine Meldung: Erledigt").first()).toBeVisible();
    expect(errors).toEqual([]);
    // Lehrkräfte sehen keine Prüfungen, Anlagen, Wartung, Statistik, Prüfliste, Exporte
    for (const p of ["/gebaeude/pruefungen", "/gebaeude/anlagen", "/gebaeude/wartung", "/gebaeude/statistik", "/druck/pruefliste"]) expect((await page.goto(p))?.status()).toBe(404);
    expect((await page.request.get("/api/gebaeude/export/meldungen")).status()).toBe(404);
  });

  test("Prüfungen: Fälligkeiten, Erinnerung per Gong, Mangel → Meldung, Protokoll nur als PDF (Download, nosniff)", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    // Verwaltung prüft die Fristen sofort (wie der nächtliche Lauf)
    await login(page, "sabine.kowalski");
    await page.goto("/gebaeude/pruefungen");
    const list = page.getByRole("list", { name: "Prüfungen" });
    await expect(list.getByRole("listitem").filter({ hasText: "Stehleiter 6 Stufen" })).toContainText("überfällig");
    await expect(list.getByRole("listitem").filter({ hasText: "Feuerlöscher Flur EG" })).toContainText("bald fällig");
    await page.getByRole("form", { name: "Fristen prüfen" }).getByRole("button", { name: "Fristen jetzt prüfen" }).click();
    await expect(page.getByRole("form", { name: "Fristen prüfen" }).getByRole("status")).toContainText("Erinnert: 1 überfällig, 1 bald fällig");
    await page.screenshot({ path: `${SHOTS}/gebaeude-pruefungen.png`, fullPage: true });

    // Hausmeister: Gong, Mangel an der Leiter erfassen → Meldung entsteht
    await logoutForSwitch(page);
    await login(page, "klaus.berger");
    await openGong(page);
    await expect(page.getByText("Prüfungen: 1 überfällig, 1 bald fällig").first()).toBeVisible();
    await page.goto("/gebaeude/pruefungen?stand=ueberfaellig");
    // Q5-29: Hausmeisterei pflegt keine Prüfarten – Hinweis, wo das Intervall herkommt
    await expect(page.getByText("Intervalle je Prüfart legt die Verwaltung fest")).toBeVisible();
    const ladder = page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: "Stehleiter 6 Stufen" });
    await ladder.getByText("Ergebnis erfassen").click();
    const rec = ladder.getByRole("form", { name: /^Prüfung erfassen/ });
    await rec.getByLabel("Ergebnis").selectOption({ label: "Mangel" });
    await rec.getByLabel("Firma bzw. Stelle").fill("Hausmeisterei");
    await rec.getByLabel("Bemerkung").fill("Sprosse 3 locker, Leiter gesperrt");
    await rec.getByRole("button", { name: "Prüfung erfassen" }).click();
    await expect(page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: "Stehleiter 6 Stufen" })).toHaveCount(0);
    await page.goto("/gebaeude/pruefungen?stand=erledigt");
    const done = page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: "Stehleiter 6 Stufen" }).filter({ hasText: "Mangel" });
    await done.getByRole("link", { name: "Meldung" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Prüfung Leitern und Tritte: Mangel – Stehleiter 6 Stufen (LE-001)");
    await expect(page.getByText("Sprosse 3 locker")).toBeVisible();

    // Feuerlöscher ohne Mangel mit Protokoll: falsches „PDF“ abgelehnt, echtes gespeichert und als Download ausgeliefert
    await page.goto("/gebaeude/pruefungen");
    const ext = page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: "Feuerlöscher Flur EG" });
    await ext.getByText("Ergebnis erfassen").click();
    let form = ext.getByRole("form", { name: /^Prüfung erfassen/ });
    await form.getByLabel("Firma bzw. Stelle").fill("Brandschutz Muster GmbH");
    await form.getByLabel("Protokoll (PDF)").setInputFiles(FAKE_PDF);
    await form.getByRole("button", { name: "Prüfung erfassen" }).click();
    await expect(form.getByText("Protokoll nur als PDF")).toBeVisible();
    form = ext.getByRole("form", { name: /^Prüfung erfassen/ });
    await form.getByLabel("Protokoll (PDF)").setInputFiles(PDF);
    // erst die Antwort der Server Action abwarten, sonst bricht die Navigation darunter das Speichern ab
    const saved = page.waitForResponse((r) => r.request().method() === "POST");
    await form.getByRole("button", { name: "Prüfung erfassen" }).click();
    await saved;
    await page.goto("/gebaeude/pruefungen?stand=erledigt");
    const link = page.getByRole("list", { name: "Prüfungen" }).getByRole("listitem").filter({ hasText: "Feuerlöscher Flur EG" }).getByRole("link", { name: "Protokoll (PDF)" });
    const res = await page.request.get((await link.getAttribute("href"))!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect(res.headers()["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-security-policy"]).toContain("sandbox");
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(errors).toEqual([]);
  });

  test("Verwaltung, Anlagen-Import, Wartung, Prüfliste und CSV ohne Namen", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/gebaeude");
    const types = page.getByRole("list", { name: "Prüfarten" });
    await expect(types.getByRole("listitem")).toHaveCount(12);
    await expect(page.getByText("alles zu prüfen")).toBeVisible();
    const lift = types.getByRole("listitem").filter({ hasText: "Aufzüge" });
    await lift.locator("summary").click();
    await lift.getByLabel("eingeschaltet").check();
    await lift.getByRole("button", { name: "Speichern" }).click();
    await expect(lift.getByRole("status")).toContainText("Gespeichert.");
    await page.screenshot({ path: `${SHOTS}/gebaeude-verwaltung.png`, fullPage: true });
    // dieselbe Pflege im Modul (für „configure“ ohne Verwaltungszugang, Code-Review Gate 4a N5)
    await page.goto("/gebaeude/pruefarten");
    await expect(page.getByRole("list", { name: "Prüfarten" }).getByRole("listitem")).toHaveCount(12);
    // Q5-29: Intervall wirkt erst ab der nächsten erfassten Prüfung
    await page.getByRole("list", { name: "Prüfarten" }).getByRole("listitem").first().locator("summary").click();
    await expect(page.getByText("gilt ab der nächsten erfassten Prüfung").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Gebäude & Technik" }).getByRole("link", { name: "Prüfarten" })).toHaveAttribute("aria-current", "page");

    await page.goto("/gebaeude/anlagen");
    const imp = page.getByRole("form", { name: "Inventarliste importieren" });
    await imp.getByLabel("CSV-Datei").setInputFiles({
      name: "inventar.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Name;Art;Raum;Inventarnummer\nAufzug Pavillon;Aufzug;;AZ-7\nFeuerlöscher Musik;Feuerlöscher;MU1;FL-7\n", "utf8"),
    });
    await imp.getByRole("button", { name: "Importieren" }).click();
    await expect(imp.getByRole("status")).toContainText("2 angelegt, 0 aktualisiert");
    await expect(page.getByRole("table", { name: "Anlagen und Geräte" })).toContainText("Aufzug Pavillon");

    await page.goto("/druck/pruefliste");
    await expect(page.getByRole("heading", { level: 1, name: "Prüfliste" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Aufzüge" })).toContainText("Aufzug Pavillon (AZ-7)");
    await page.screenshot({ path: `${SHOTS}/gebaeude-pruefliste.png`, fullPage: true });

    const csv = await page.request.get("/api/gebaeude/export/meldungen");
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const text = await csv.text();
    expect(text).toContain("Nummer;Kategorie;Priorität;Status;Ort;Gebäude;Titel");
    expect(text).not.toMatch(/Jana|Brandt|Klaus|Berger|Kowalski/);

    // Hausmeister trägt eine Wartung ein (mit Raumsperre und Schulkalender)
    await logoutForSwitch(page);
    await login(page, "klaus.berger");
    await page.goto("/gebaeude/wartung");
    const w = page.getByRole("form", { name: "Wartungstermin eintragen" });
    await w.getByLabel("Was wird gewartet?").fill("Wartung Klavier");
    await w.getByLabel("Firma").fill("Pianohaus GmbH");
    await w.getByLabel("Räume", { exact: true }).selectOption(["MU1"]);
    await w.getByLabel("Räume für den Zeitraum sperren (ganze Tage)").check();
    await w.getByRole("button", { name: "Eintragen" }).click();
    await expect(w.getByRole("status")).toContainText("Gespeichert");
    const item = page.getByRole("list", { name: "Kommende Wartungstermine" }).getByRole("listitem").filter({ hasText: "Wartung Klavier" });
    await expect(item).toContainText("Raum MU1");
    await expect(item).toContainText("Räume gesperrt");
    await expect(item).toContainText("im Schulkalender");
    await page.screenshot({ path: `${SHOTS}/gebaeude-wartung.png`, fullPage: true });
    await item.getByRole("button", { name: "Wartung Klavier absagen" }).click();
    await expect(page.getByRole("list", { name: "Kommende Wartungstermine" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
