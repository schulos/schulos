import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// INV-06/INV-07: Inventarliste im Schulträgerformat (Export, Import mit Vorschau und Spaltenzuordnung), Frist-Hinweis in
// „Offen für dich“, Karte „Inventar“ im Raumsteckbrief – am Handy (360 px, dunkel, axe inkl. Zielgröße). Dazu die Rechte-Matrix
// (configure, inventory über die Gruppe, verantwortliche Gruppe einer Kategorie, Lehrkraft, Schülerin, abgemeldet) und der
// Scan-Weg Etikett → Anmeldung → Geräteseite. Eigene Einträge (E2E-…); die Kategorie-Verantwortung wird am Ende zurückgesetzt.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const MOBILE = { viewport: { width: 360, height: 800 }, colorScheme: "dark" as const };
const MUSIK = "Musik (Instrumente, Verstärker)";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
}

/** TT.MM.JJJJ in `days` Tagen (Berliner Datum). */
function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" }).format(d);
}

async function mobilePage(browser: Browser, user: string) {
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { ctx, page, errors };
}

test("INV-06: Export und Import im Schulträgerformat (Vorschau, Spaltenzuordnung), Frist in „Offen für dich“, Karte im Raumsteckbrief", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, errors } = await mobilePage(browser, "sabine.kowalski");
  await page.goto("/gebaeude/inventar");
  await noOverflow(page);

  // Export: Kopfzeile des Schulträgerformats, Demo-Inventar enthalten
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Als CSV exportieren" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^gebaeude-inventar-\d{4}-\d{2}-\d{2}\.csv$/);
  const exported = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
  expect(exported.split("\r\n")[0]).toBe(
    "Inventarnummer;Bezeichnung;Kategorie;Hersteller;Modell;Seriennummer;Menge;Zustand;Gebäude;Etage;Raum;Anschaffungsdatum;Preis (EUR);Lieferant;Finanzierung;Zweckbindung bis;Garantie bis;Letzte Prüfung;Nächste Prüfung;Ausgemustert am",
  );
  expect(exported).toContain("IT-0001;Tablet-Koffer 7. Jahrgang (16 Geräte);");

  // Import mit fremden Spaltennamen: „Ort“ wird erst nicht erkannt, dann in der Vorschau dem Raum zugeordnet
  const csv = `Inv.-Nr.;Gegenstand;Gruppe;Ort;Garantie bis;Preis\nE2E-INV-1;E2E Laptop Lehrerzimmer;IT;IF1;${inDays(20)};899,00\nE2E-INV-2;E2E Stühle Informatik;Möbel;IF1;;\n`;
  const importCard = page.getByRole("article", { name: "Inventarliste importieren (CSV, Schulträgerformat)" });
  await importCard.getByLabel("CSV-Datei").setInputFiles({ name: "schultraeger.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  await importCard.getByRole("button", { name: "Prüfen (Vorschau)" }).click();
  const summary = importCard.getByRole("status").filter({ hasText: "neu ·" });
  await expect(summary).toHaveText("2 neu · 0 ändern · 0 unverändert · 0 übersprungen · 0 mit Fehlern");
  await importCard.getByText("Spaltenzuordnung").click();
  const ort = importCard.getByLabel("Spalte 4: „Ort“");
  await expect(ort).toHaveValue("");
  await expect(importCard.getByLabel("Spalte 2: „Gegenstand“")).toHaveValue("name");
  await ort.selectOption({ label: "Raum" });
  await importCard.getByRole("button", { name: "Mit dieser Zuordnung neu prüfen" }).click();
  await expect(importCard.getByLabel("Spalte 4: „Ort“")).toHaveValue("roomId");
  await expect(importCard.getByRole("table", { name: "Vorschau des Imports" })).toContainText("E2E Stühle Informatik");
  // Trockenlauf: noch nichts gespeichert
  expect((await page.request.get(`/gebaeude/inventar?q=E2E-INV-1`)).ok()).toBe(true);
  expect(await (await page.request.get(`/gebaeude/inventar?q=E2E-INV-1`)).text()).not.toContain("E2E Laptop Lehrerzimmer");
  await noOverflow(page);
  await axeClean(page);
  await importCard.getByRole("button", { name: "2 Einträge übernehmen" }).click();
  await expect(importCard.getByRole("status")).toHaveText("Übernommen: 2 angelegt, 0 aktualisiert.");

  // Frist-Hinweis in „Offen für dich“ → gefilterte Liste
  await page.goto("/");
  const due = page.locator('[data-widget="heute.offen"] [data-open-item="gebaeude:garantie"]');
  await expect(due).toContainText("Garantie läuft ab");
  await expect(due).toContainText("E2E Laptop Lehrerzimmer");
  await due.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/gebaeude\/inventar\?frist=garantie$/);
  const list = page.getByRole("table", { name: "Inventar" });
  await expect(list).toContainText("E2E-INV-1");
  await expect(list).not.toContainText("IT-0001");

  // Raumsteckbrief: Karte „Inventar“ mit Anzahl je Kategorie → gefilterte Liste
  await page.goto("/raeume/IF1");
  const card = page.getByRole("article", { name: "Inventar", exact: true });
  await expect(card).toContainText("Einträge");
  const moebel = card.getByRole("link", { name: /^Möbel/ });
  await expect(moebel).toContainText("1");
  await noOverflow(page);
  await axeClean(page);
  await moebel.click();
  await expect(page).toHaveURL(/\/gebaeude\/inventar\?raum=IF1&kategorie=/);
  await expect(page.getByRole("table", { name: "Inventar" })).toContainText("E2E Stühle Informatik");
  await expect(page.getByRole("table", { name: "Inventar" })).not.toContainText("E2E Laptop Lehrerzimmer");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("INV-07: Rechte-Matrix des Inventars und Scan-Weg Etikett → Anmeldung → Geräteseite", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());

  // configure (Verwaltung): Gerät anlegen, Etikett drucken, Kategorie Musik der Gruppe „Schulkonferenz“ geben
  await login(page, "sabine.kowalski");
  await page.goto("/gebaeude/inventar");
  const neu = page.getByRole("form", { name: "Inventar anlegen" });
  await neu.getByLabel("Bezeichnung").fill("E2E Gitarre");
  await neu.getByLabel("Kategorie").selectOption({ label: MUSIK });
  await neu.getByLabel("Raum").selectOption("106");
  await neu.getByLabel("Seriennummer").fill("SN-E2E-77");
  await neu.getByRole("button", { name: "Anlegen" }).click();
  await expect(page).toHaveURL(/\/gebaeude\/inventar\/[^/?]+\?angelegt=1$/);
  const assetPath = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "Etikett drucken" }).click();
  const qr = page.getByRole("article", { name: /^Etikett MU-/ }).getByRole("img", { name: /^QR-Code / });
  const code = (await qr.getAttribute("aria-label"))!.match(/\/i\/([0-9A-Z]{16})$/)![1]!;
  await page.goto("/gebaeude/inventar/kategorien");
  const item = page.getByRole("list", { name: "Kategorien" }).getByRole("listitem").filter({ hasText: MUSIK });
  await item.locator("summary").click();
  const form = item.getByRole("form", { name: `Kategorie ${MUSIK}` });
  await form.getByLabel("verantwortliche Gruppe").selectOption({ label: "Schulkonferenz" });
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert.");
  expect((await page.request.get("/api/gebaeude/export/inventar")).status()).toBe(200);
  await logoutForSwitch(page);

  try {
    // Scan-Weg: Kamera-App öffnet /i/<code> → Anmeldeseite → nach der Anmeldung direkt die Geräteseite (Hausmeisterei: volle Sicht)
    const scan = await browser.newContext(MOBILE);
    const s = await scan.newPage();
    const scanErrors = collectErrors(s);
    await s.goto(`/i/${code}`);
    await expect(s).toHaveURL(`/login?next=${encodeURIComponent(`/i/${code}`)}`);
    await s.getByLabel("Benutzername").fill("klaus.berger");
    await s.getByLabel("Passwort").fill("schulos");
    await s.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(s).toHaveURL(assetPath);
    await expect(s.getByRole("heading", { level: 1, name: "E2E Gitarre" })).toBeVisible();
    await expect(s.getByRole("form", { name: "Zustand setzen" })).toBeVisible();
    await expect(s.getByText("SN-E2E-77")).toBeVisible();
    await noOverflow(s);
    await axeClean(s);
    // inventory über die Gruppe: Liste, Import, Export, Etiketten – keine Kategorien
    await s.goto("/gebaeude/inventar");
    await expect(s.getByRole("article", { name: "Inventarliste importieren (CSV, Schulträgerformat)" })).toBeVisible();
    await expect(s.getByRole("link", { name: "Etiketten drucken" })).toBeVisible();
    await expect(s.getByRole("link", { name: "Kategorien" })).toHaveCount(0);
    expect((await s.request.get("/gebaeude/inventar/kategorien")).status()).toBe(404);
    expect((await s.request.get("/api/gebaeude/export/inventar")).status()).toBe(200);
    expect(scanErrors).toEqual([]);
    await scan.close();

    // verantwortliche Gruppe (Lehrkraft in der Schulkonferenz): nur Musik – Liste, Export, volle Geräteseite; keine Kategorien
    const t = await mobilePage(browser, "jana.brandt");
    await t.page.goto("/gebaeude/inventar");
    const own = t.page.getByRole("table", { name: "Inventar" });
    await expect(own).toContainText("E2E Gitarre");
    await expect(own).not.toContainText("IT-0001");
    const csv = await (await t.page.request.get("/api/gebaeude/export/inventar")).text();
    expect(csv).toContain("E2E Gitarre");
    expect(csv).not.toContain("IT-0001");
    await t.page.goto(`/i/${code}`);
    await expect(t.page).toHaveURL(assetPath);
    await expect(t.page.getByText("SN-E2E-77")).toBeVisible();
    expect((await t.page.request.get("/gebaeude/inventar/kategorien")).status()).toBe(404);
    // Raumsteckbrief: Karte zeigt nur die eigene Kategorie
    await t.page.goto("/raeume/106");
    const card = t.page.getByRole("article", { name: "Inventar", exact: true });
    await expect(card.getByRole("link", { name: /^Musik/ })).toBeVisible();
    await expect(card.getByRole("link", { name: /^Elektro|^Präsentation/ })).toHaveCount(0);
    await axeClean(t.page);
    expect(t.errors).toEqual([]);
    await t.ctx.close();
  } finally {
    // Verantwortung zurücknehmen, damit andere Specs die Lehrkraft ohne Inventarsicht vorfinden
    await login(page, "sabine.kowalski");
    await page.goto("/gebaeude/inventar/kategorien");
    const item2 = page.getByRole("list", { name: "Kategorien" }).getByRole("listitem").filter({ hasText: MUSIK });
    await item2.locator("summary").click();
    const form2 = item2.getByRole("form", { name: `Kategorie ${MUSIK}` });
    await form2.getByLabel("verantwortliche Gruppe").selectOption("");
    await form2.getByRole("button", { name: "Speichern" }).click();
    await expect(form2.getByRole("status")).toContainText("Gespeichert.");
    await logoutForSwitch(page);
  }

  // Lehrkraft ohne Verantwortung: eingeschränkte Sicht über das Etikett, keine Liste, kein Export, keine Karte im Steckbrief
  const t2 = await mobilePage(browser, "jana.brandt");
  await t2.page.goto(`/i/${code}`);
  await expect(t2.page).toHaveURL(assetPath);
  await expect(t2.page.getByRole("heading", { level: 1, name: "E2E Gitarre" })).toBeVisible();
  await expect(t2.page.getByRole("link", { name: "Mangel melden" })).toBeVisible();
  await expect(t2.page.getByText(/SN-E2E-77|Seriennummer|Preis|Finanzierung/)).toHaveCount(0);
  await expect(t2.page.getByRole("form", { name: "Zustand setzen" })).toHaveCount(0);
  expect((await t2.page.request.get("/gebaeude/inventar")).status()).toBe(404);
  expect((await t2.page.request.get("/api/gebaeude/export/inventar")).status()).toBe(404);
  await t2.page.goto("/raeume/106");
  await expect(t2.page.getByRole("article", { name: "Inventar", exact: true })).toHaveCount(0);
  expect(t2.errors).toEqual([]);
  await t2.ctx.close();

  // Schülerin: über das Etikett nur Bezeichnung/Kategorie/Standort, ohne „Mangel melden“ (kein gebaeude.report), sonst nichts
  const st = await mobilePage(browser, "lea.schaefer");
  await st.page.goto(`/i/${code}`);
  await expect(st.page).toHaveURL(assetPath);
  await expect(st.page.getByRole("heading", { level: 1, name: "E2E Gitarre" })).toBeVisible();
  await expect(st.page.getByRole("link", { name: "Mangel melden" })).toHaveCount(0);
  await expect(st.page.getByText(/SN-E2E-77|Seriennummer|Preis/)).toHaveCount(0);
  await noOverflow(st.page);
  await axeClean(st.page);
  expect((await st.page.request.get("/gebaeude/inventar")).status()).toBe(404);
  expect((await st.page.request.get("/api/gebaeude/export/inventar")).status()).toBe(404);
  expect(st.errors).toEqual([]);
  await st.ctx.close();

  // abgemeldet: Export ohne Anmeldung nicht lesbar
  const anon = await browser.newContext();
  const a = await anon.newPage();
  expect([401, 403, 404]).toContain((await a.request.get("/api/gebaeude/export/inventar", { maxRedirects: 0 })).status());
  await anon.close();
  expect(errors).toEqual([]);
});
