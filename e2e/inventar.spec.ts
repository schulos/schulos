import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// INV-01/INV-02: Inventar anlegen (automatische Nummer), Liste und Filter, Etikett drucken (Bogen/Rolle, Sammeldruck),
// `/i/<code>` abgemeldet → nur die Anmeldeseite (gleich für gültige und ungültige Codes), angemeldet ohne Pflegerecht nur die
// eingeschränkte Sicht (inv-5), Hausmeisterei pflegt über das Gruppenrecht, Kategorien nur mit configure, Neuerzeugen entwertet,
// Ausmustern blendet aus. Eigene Einträge (E2E-…) damit andere Specs unberührt bleiben.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("INV-01/02: Inventar anlegen, Etikett drucken, /i/<code> Rechte, Neuerzeugen, Ausmustern", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "sabine.kowalski");

  // Liste mit Demo-Inventar, alter Pfad leitet um
  await page.goto("/gebaeude/anlagen");
  await expect(page).toHaveURL(/\/gebaeude\/inventar$/);
  const table = page.getByRole("table", { name: "Inventar" });
  await expect(table).toContainText("Tablet-Koffer 7. Jahrgang");
  await expect(table).toContainText("IT-0001");
  await expect(page.getByRole("navigation", { name: "Gebäude & Technik" }).getByRole("link", { name: "Inventar" })).toHaveAttribute("aria-current", "page");
  await axeClean(page);

  // Filter: Kategorie IT → nur IT; Suche
  await page.getByRole("form", { name: "Filter" }).getByLabel("Kategorie").selectOption({ label: "IT (Laptops, Tablets, PCs, Drucker, Server, Netzwerk, USV)" });
  await page.getByRole("form", { name: "Filter" }).getByRole("button", { name: "Filtern" }).click();
  await expect(page).toHaveURL(/kategorie=/);
  await expect(page.getByRole("table", { name: "Inventar" })).toContainText("IT-0001");
  await expect(page.getByRole("table", { name: "Inventar" })).not.toContainText("FL-001");

  // Anlegen ohne Nummer → Zähler der Kategorie (AV-0001 ist Demo → AV-0002), Weiterleitung auf die Asset-Seite
  await page.goto("/gebaeude/inventar");
  const neu = page.getByRole("form", { name: "Inventar anlegen" });
  await neu.getByLabel("Bezeichnung").fill("E2E Dokumentenkamera Bio");
  await neu.getByLabel("Kategorie").selectOption({ label: "Präsentation/AV (Beamer, Displays, Dokumentenkameras, Ton)" });
  await neu.getByLabel("Raum").selectOption("NW1");
  await neu.getByLabel("Zustand").selectOption("neu");
  await neu.getByLabel("Preis (Euro)").fill("1.234,56");
  await neu.getByRole("button", { name: "Anlegen" }).click();
  await expect(page).toHaveURL(/\/gebaeude\/inventar\/[^/?]+\?angelegt=1$/);
  const assetUrl = page.url().replace(/\?.*$/, "");
  await expect(page.getByRole("status")).toContainText(/Angelegt – Inventarnummer AV-\d{4}/);
  const inventoryNo = (await page.getByRole("status").textContent())!.match(/AV-\d{4}/)![0];
  await expect(page.getByRole("heading", { level: 1, name: "E2E Dokumentenkamera Bio" })).toBeVisible();
  await expect(page.getByText("1.234,56 €")).toBeVisible();
  await expect(page.getByText("Noch kein Etikett gedruckt")).toBeVisible();
  await axeClean(page);

  // Etikett drucken: Code entsteht, Bogen 3×8 (Vorgabe), Rolle umschaltbar
  await page.getByRole("link", { name: "Etikett drucken" }).click();
  await expect(page).toHaveURL(/\/druck\/inventar-etiketten\?asset=/);
  const label = page.getByRole("article", { name: `Etikett ${inventoryNo}` });
  await expect(label).toContainText("E2E Dokumentenkamera Bio");
  const qr = label.getByRole("img", { name: /^QR-Code / });
  const code = (await qr.getAttribute("aria-label"))!.match(/\/i\/([0-9A-Z]{16})$/)?.[1];
  expect(code).toBeTruthy();
  await expect(page.getByRole("region", { name: "Bogen 1" })).toBeVisible();
  await axeClean(page);
  await page.getByRole("link", { name: /^Endlosrolle 62 mm/ }).click();
  await expect(page).toHaveURL(/format=rolle-62/);
  await expect(page.getByRole("region", { name: "Etikett 1" })).toBeVisible();
  await expect(page.getByRole("article", { name: `Etikett ${inventoryNo}` }).getByRole("img", { name: /^QR-Code / })).toHaveAttribute("aria-label", new RegExp(`/i/${code}$`));

  // Asset-Seite zeigt den Code; Liste zeigt „gedruckt“
  await page.goto(assetUrl);
  await expect(page.getByText(new RegExp(`/i/${code}$`))).toBeVisible();
  await page.goto(`/gebaeude/inventar?q=${encodeURIComponent("E2E Dokumentenkamera")}`);
  await expect(page.getByRole("table", { name: "Inventar" }).getByRole("row").filter({ hasText: inventoryNo })).toContainText("gedruckt");

  // Sammeldruck: Auswahl → zwei Etiketten, ab Position 3 auf dem Bogen; Code unverändert
  await page.goto("/gebaeude/inventar/etiketten");
  const pick = page.getByRole("form", { name: "Etiketten auswählen" });
  await pick.getByRole("checkbox", { name: new RegExp(`^${inventoryNo}`) }).check();
  await pick.getByRole("checkbox", { name: /^IT-0001/ }).check();
  await pick.getByLabel("ab Etikett Nr. (angefangener Bogen)").selectOption("3");
  await pick.getByRole("button", { name: "Gewählte drucken" }).click();
  await expect(page.getByRole("article", { name: /^Etikett / })).toHaveCount(2);
  await expect(page.getByText("beginnt bei Etikett 3")).toBeVisible();
  await expect(page.getByRole("article", { name: `Etikett ${inventoryNo}` }).getByRole("img", { name: /^QR-Code / })).toHaveAttribute("aria-label", new RegExp(`/i/${code}$`));
  expect(errors).toEqual([]);

  // abgemeldet: gültiger und ungültiger Code führen gleich auf die Anmeldeseite – ohne Inventarinfo
  const anon = await browser.newContext();
  const a = await anon.newPage();
  const valid = await a.goto(`/i/${code}`);
  await expect(a).toHaveURL(`/login?next=${encodeURIComponent(`/i/${code}`)}`);
  const validText = (await a.locator("main").innerText()).replaceAll(code!, "CODE");
  await expect(a.getByText(/Dokumentenkamera|AV-\d{4}/)).toHaveCount(0);
  const fake = "ZZZZZZZZZZZZZZZZ";
  const invalid = await a.goto(`/i/${fake}`);
  await expect(a).toHaveURL(`/login?next=${encodeURIComponent(`/i/${fake}`)}`);
  expect((await a.locator("main").innerText()).replaceAll(fake, "CODE")).toBe(validText);
  expect(invalid?.status()).toBe(valid?.status());
  await anon.close();

  // Lehrkraft ohne Pflegerecht (schmal, dunkel): /i/<code> → eingeschränkte Sicht, Liste 404
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark" });
  const t = await narrow.newPage();
  const teacherErrors = collectErrors(t);
  await login(t, "jana.brandt");
  await t.goto(`/i/${code}`);
  await expect(t).toHaveURL(assetUrl);
  await expect(t.getByRole("heading", { level: 1, name: "E2E Dokumentenkamera Bio" })).toBeVisible();
  await expect(t.getByText(/^Präsentation/)).toBeVisible();
  await expect(t.getByText("Raum NW1")).toBeVisible();
  await expect(t.getByRole("link", { name: "Mangel melden" })).toHaveAttribute("href", "/gebaeude/melden?raum=NW1");
  await expect(t.getByText(/Seriennummer|Preis|Finanzierung|Etikett/)).toHaveCount(0);
  expect(await t.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(t);
  // 404-Prüfungen per request (ein goto auf 404 landet als Konsolenfehler in collectErrors)
  expect((await t.request.get("/gebaeude/inventar")).status()).toBe(404);
  expect((await t.request.get("/gebaeude/inventar/etiketten")).status()).toBe(404);
  expect((await t.request.get(`/i/${fake}`)).status()).toBe(404);
  expect(teacherErrors).toEqual([]);
  await narrow.close();

  // Hausmeisterei pflegt über das Gruppenrecht: Liste, Etiketten drucken ja – Kategorien (configure) nein
  await logoutForSwitch(page);
  await login(page, "klaus.berger");
  await page.goto("/gebaeude/inventar");
  await expect(page.getByRole("table", { name: "Inventar" })).toContainText("IT-0001");
  await expect(page.getByRole("link", { name: "Etiketten drucken" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Inventar anlegen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kategorien" })).toHaveCount(0);
  expect((await page.request.get("/gebaeude/inventar/kategorien")).status()).toBe(404);

  // Verwaltung: Kategorie anlegen, neuen Code erzeugen (alter ungültig), ausmustern
  await logoutForSwitch(page);
  await login(page, "sabine.kowalski");
  await page.goto("/gebaeude/inventar/kategorien");
  await expect(page.getByRole("list", { name: "Kategorien" }).getByRole("listitem")).toHaveCount(20);
  const kat = page.getByRole("form", { name: "Eigene Kategorie anlegen" });
  await kat.getByLabel("Name").fill("E2E Robotik");
  await kat.getByLabel("Präfix der Inventarnummer").fill("rb");
  await kat.getByRole("button", { name: "Anlegen" }).click();
  await expect(kat.getByRole("status")).toContainText("Angelegt.");
  await expect(page.getByRole("list", { name: "Kategorien" }).getByRole("listitem").filter({ hasText: "E2E Robotik" })).toContainText("RB");
  await axeClean(page);

  await page.goto(assetUrl);
  await page.getByRole("button", { name: "Neuen Code erzeugen" }).click();
  await expect(page.getByText(new RegExp(`/i/${code}$`))).toHaveCount(0);
  await expect(page.getByText(/\/i\/[0-9A-Z]{16}$/)).toBeVisible();
  expect((await page.request.get(`/i/${code}`)).status()).toBe(404);

  await page.goto(assetUrl);
  const retire = page.getByRole("form", { name: "Inventar ausmustern" });
  await retire.getByLabel("Grund").fill("E2E: defekt");
  await retire.getByRole("button", { name: "Ausmustern" }).click();
  // nach dem Ausmustern rendert die Seite neu: Formular „Wieder in Betrieb nehmen“ statt „Ausmustern“
  await expect(page.getByRole("form", { name: "Inventar wieder in Betrieb nehmen" })).toBeVisible();
  await expect(page.getByText(/^ausgemustert/).first()).toBeVisible();
  await page.goto(`/gebaeude/inventar?q=${encodeURIComponent("E2E Dokumentenkamera")}`);
  await expect(page.getByText("Kein Inventar")).toBeVisible();
  await page.goto(`/gebaeude/inventar?q=${encodeURIComponent("E2E Dokumentenkamera")}&alle=1`);
  await expect(page.getByRole("table", { name: "Inventar" })).toContainText("ausgemustert");
  expect(errors).toEqual([]);
});
