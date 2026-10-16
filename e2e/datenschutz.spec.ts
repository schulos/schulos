import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Löschlauf: Vorschau, Löschsperre mit Begründung, Bestätigung nötig; Sekretariat hat keinen Zugriff", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/datenschutz");
  await page.getByRole("link", { name: "Löschlauf und Sperren" }).click();
  await expect(page.getByRole("heading", { name: "Löschlauf", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Vorschau für heute/ })).toBeVisible();
  await page.getByText(/^Nicht vom Löschlauf erfasst/).click();
  await expect(page.getByText(/wird mit dem Konto gelöscht/).first()).toBeVisible();

  const hold = page.getByRole("form", { name: "Löschsperre anlegen" });
  await hold.getByLabel("Person (Benutzername)").fill("lea.schaefer");
  await hold.getByLabel("Begründung").fill("kurz");
  await hold.getByRole("button", { name: "Sperre anlegen" }).click();
  await expect(hold.getByRole("alert")).toContainText("Begründung mit 5 bis 200 Zeichen");
  await hold.getByLabel("Begründung").fill("Widerspruchsverfahren Zeugnis");
  await hold.getByRole("button", { name: "Sperre anlegen" }).click();
  await expect(hold.getByRole("status")).toHaveText("Sperre angelegt.");
  const holds = page.getByRole("table", { name: "Aktive Löschsperren" });
  await expect(holds.getByRole("row").filter({ hasText: "Lea Schäfer" })).toContainText("Widerspruchsverfahren Zeugnis");
  await page.screenshot({ path: ".data/shots/e2e/loeschlauf.png", fullPage: true });

  const run = page.getByRole("form", { name: "Löschlauf ausführen" });
  if (await run.getByRole("button", { name: "Löschlauf jetzt ausführen" }).isEnabled()) {
    await run.getByRole("button", { name: "Löschlauf jetzt ausführen" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Vorschau geprüft");
    await run.getByLabel("Vorschau geprüft").check();
    await run.getByRole("button", { name: "Löschlauf jetzt ausführen" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Löschlauf ausgeführt/ })).toBeVisible();
    await expect(page.getByRole("table", { name: "Löschprotokoll" }).getByText("von Hand")).toBeVisible();
  }
  await page.getByRole("button", { name: "Sperre Lea Schäfer aufheben" }).click();
  await expect(page.getByText("Keine aktiven Sperren.")).toBeVisible();
  expect(errors).toEqual([]);

  await page.context().clearCookies();
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/datenschutz");
  await expect(page.getByRole("link", { name: "Löschlauf und Sperren" })).toHaveCount(0);
  expect((await page.goto("/verwaltung/datenschutz/loeschlauf"))?.status()).toBe(404);
});

test("Konto-Lebenszyklus: Abgang eintragen und zurücknehmen; Löschung auf Antrag mit Anzeige, was bleibt", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/benutzer/neu");
  await page.getByLabel("Vorname").fill("Ole");
  await page.getByLabel("Nachname").fill("Abgangstest");
  await page.getByLabel("Rolle").selectOption("schueler");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Benutzer angelegt")).toBeVisible();

  await page.goto("/verwaltung/benutzer?q=ole.abgangstest");
  await page.getByRole("link", { name: /Abgangstest, Ole/ }).click();
  await page.getByRole("button", { name: "Abgang eintragen" }).click();
  await page.getByRole("form", { name: "Abgang eintragen" }).getByRole("button", { name: "Abgang speichern" }).click();
  await expect(page.getByText(/^Abgang am .* gesperrt\. Der Löschlauf löscht es ab/)).toBeVisible();
  await expect(page.getByRole("main").getByText("Abgang", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Abgang zurücknehmen" }).click();
  await expect(page.getByText("Das Konto ist aktiv.")).toBeVisible();

  await page.getByRole("link", { name: /Löschung auf Antrag/ }).click();
  await expect(page.getByRole("heading", { name: "Löschung auf Antrag", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Wird gelöscht/ })).toBeVisible();
  await page.getByRole("button", { name: "Konto jetzt löschen" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Antrag geprüft");
  await page.getByLabel(/Antrag geprüft/).check();
  await page.getByRole("button", { name: "Konto jetzt löschen" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("Konto auf Antrag gelöscht");
  await page.goto("/verwaltung/benutzer?q=ole.abgangstest");
  await expect(page.getByText("Keine Benutzer gefunden")).toBeVisible();

  // Lehrkraft mit Klassenbuch: Akte bleibt, Löschung nur vormerkbar
  await page.goto("/verwaltung/benutzer/u-jana.brandt/loeschen");
  await expect(page.getByRole("heading", { name: /Bleibt wegen Aktenpflicht/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sperren und Löschung vormerken" })).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/loeschantrag.png", fullPage: true });
  expect(errors).toEqual([]);

  // Sekretariat: Abgang ja, Löschung auf Antrag nein
  await page.context().clearCookies();
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/benutzer/u-lea.schaefer");
  await expect(page.getByRole("button", { name: "Abgang eintragen" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Löschung auf Antrag/ })).toHaveCount(0);
  expect((await page.goto("/verwaltung/benutzer/u-lea.schaefer/loeschen"))?.status()).toBe(404);
});

test("Auskunft (Art. 15): ZIP-Download aus der Benutzerseite, nur mit Datenschutz-Recht", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/benutzer/u-lea.schaefer");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Auskunft \(Art\. 15\)/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^auskunft_lea\.schaefer_\d{4}-\d{2}-\d{2}\.zip$/);
  const file = await download.path();
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("uebersicht.json"))).toBe(true);
  expect(errors).toEqual([]);

  await page.context().clearCookies();
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/benutzer/u-lea.schaefer");
  await expect(page.getByRole("button", { name: /Auskunft \(Art\. 15\)/ })).toHaveCount(0);
  const res = await page.request.post("/api/datenschutz/auskunft/u-lea.schaefer");
  expect(res.status()).toBe(403);
});

test("Eigenexport: „Meine Dateien und Abgaben herunterladen“ im Benutzermenü", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  await page.getByRole("button", { name: /Lea Schäfer/ }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Meine Dateien und Abgaben herunterladen" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^meine-daten_lea\.schaefer_\d{4}-\d{2}-\d{2}\.zip$/);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("LIESMICH.txt"))).toBe(true);
  expect(errors).toEqual([]);
  // SEC-05: nur per POST – ein Bild im Forum (`![](/api/eigenexport)`) bzw. ein Link startet keinen Export
  expect((await page.request.get("/api/eigenexport")).status()).toBe(405);
  expect((await page.request.post("/api/eigenexport", { headers: { "sec-fetch-dest": "image" } })).status()).toBe(403);
  await page.context().clearCookies();
  // ohne Sitzung: kein ZIP (Weiterleitung zur Anmeldung bzw. 401)
  const anon = await page.request.post("/api/eigenexport");
  expect(anon.headers()["content-type"] ?? "").not.toContain("application/zip");
});

test("Datenschutzhinweise ohne Anmeldung; Angaben der Schule fließen in Hinweise und VVT", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/login");
  await page.getByRole("link", { name: "Datenschutzhinweise" }).click();
  await expect(page.getByRole("heading", { name: "Datenschutzhinweise für SchulOS", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Klassenbuch", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Krankmeldungen, Entschuldigungen und Beurlaubungen", level: 3 })).toBeVisible();
  await expect(page.getByText(/Art\. 9 Abs\. 2 lit\. g/)).toBeVisible();
  // DS-14: ohne Angaben der Schule als Vorlage gekennzeichnet; Fußnote nennt die Schule als Verantwortliche
  await expect(page.getByTestId("vorlage-hinweis")).toContainText("Vorlage – von der Schule zu prüfen und anzupassen");
  await expect(page.getByTestId("vorlage-fussnote")).toContainText("Verantwortlich für die Verarbeitung");

  await login(page, "petra.lindner");
  await page.goto("/verwaltung/datenschutz");
  await page.getByRole("link", { name: "Hinweise und VVT" }).click();
  const form = page.getByRole("form", { name: "Angaben der Schule" });
  await form.getByLabel("Verantwortliche Stelle").fill("Gesamtschule am Lindenhof\nLindenweg 1, 40000 Musterstadt");
  await form.getByLabel("Datenschutzbeauftragte:r").fill("Datenschutz Schulamt, dsb@schulamt.example");
  await form.getByLabel("Betrieb der Plattform").fill("Schulträger Musterstadt (Auftragsverarbeitung)");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toHaveText("Gespeichert.");

  await page.goto("/druck/vvt");
  await expect(page.getByRole("heading", { name: /Verzeichnis der Verarbeitungstätigkeiten/ })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Schulträger Musterstadt (Auftragsverarbeitung)")).toBeVisible();
  await expect(page.getByRole("heading", { name: /\d+\. Klassenbuch/ })).toBeVisible();
  await expect(page.getByTestId("vorlage-hinweis")).toContainText("Verantwortliche nach DSGVO ist die Schule");
  await page.screenshot({ path: ".data/shots/e2e/vvt.png", fullPage: true });
  await page.goto("/datenschutzhinweise");
  await expect(page.getByText("dsb@schulamt.example", { exact: false })).toBeVisible();
  await expect(page.getByTestId("vorlage-hinweis")).toHaveCount(0);
  await expect(page.getByTestId("vorlage-fussnote")).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/datenschutzhinweise.png", fullPage: true });
  expect(errors).toEqual([]);

  await page.context().clearCookies();
  await login(page, "sabine.kowalski");
  expect((await page.goto("/druck/vvt"))?.status()).toBe(404);
});

test("Protokoll: Lesezugriff aufs Klassenbuch wird einmal protokolliert, Filter „Lesezugriffe“", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/klassenbuch/klasse");
  await expect(page.getByRole("heading", { name: "7b", level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "7b", level: 1 })).toBeVisible();

  await page.context().clearCookies();
  await login(page, "admin");
  await page.goto("/verwaltung/protokoll?bereich=lesen.");
  await expect(page.getByText(/werden vom Löschlauf pseudonymisiert/)).toBeVisible();
  const rows = page.getByRole("row").filter({ hasText: "Klassenbuch eingesehen" }).filter({ hasText: "Jana Brandt" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("7b");
  await expect(rows).toContainText("Woche und Fehlzeiten");
  expect(errors).toEqual([]);
});

test("Profilbild: nur mit Einwilligung, ohne Metadaten, Widerruf löscht sofort", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/profilbild");
  const form = page.getByRole("form", { name: "Profilbild für Jana Brandt" });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await form.getByLabel("Foto (JPEG oder PNG)").setInputFiles({ name: "ich.png", mimeType: "image/png", buffer: png });
  await form.getByRole("button", { name: "Foto speichern" }).click();
  await expect(form.getByRole("alert")).toContainText("Einwilligung bestätigen");

  await form.getByLabel("Foto (JPEG oder PNG)").setInputFiles({ name: "ich.png", mimeType: "image/png", buffer: png });
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Foto speichern" }).click();
  await expect(page.getByText("Profilbild wird angezeigt")).toBeVisible();
  await expect(page.getByText(/selbst eingewilligt am/)).toBeVisible();

  const img = page.locator('header img[src^="/api/profilbild/"]').first();
  await expect(img).toBeVisible();
  const res = await page.request.get((await img.getAttribute("src"))!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/jpeg");

  await page.getByRole("button", { name: "Einwilligung für Jana Brandt widerrufen" }).click();
  await expect(page.getByText("Kein Profilbild")).toBeVisible();
  await expect(page.locator('header img[src^="/api/profilbild/"]')).toHaveCount(0);
  expect((await page.request.get("/api/profilbild/u-jana.brandt")).status()).toBe(404);
  expect(errors).toEqual([]);
});
