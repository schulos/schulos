import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { DEMO_PASSWORD, collectErrors, login } from "./helpers";

// RS-10/RS-11: Gebäude und Etagen pflegen (Sekretariat, verwaltung.school), Raumfinder nach Gebäude/Etage (Schülerin, 360 px
// dunkel mit axe), Tür-QR: Türschild drucken, `/r/<code>` abgemeldet → nur die Anmeldeseite (gleich für gültige und ungültige
// Codes) → nach der Anmeldung der Steckbrief, neuen Code erzeugen entwertet den alten. Fester Raum TH2 (Sporthalle 2, sonst in
// keinem Spec), feste Demo-Gebäude; das angelegte Gebäude wird wieder gelöscht.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const BUILDING = "E2E-Neubau";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("RS-10: Gebäude/Etagen pflegen und Raumfinder nach Gebäude und Etage (Schülerin 360 px dunkel), aufräumen", async ({ page, browser }) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/stammdaten?bereich=raeume");
  await page.getByRole("link", { name: "Gebäude und Etagen" }).click();
  await expect(page).toHaveURL(/\/verwaltung\/stammdaten\/raeume\/gebaeude$/);
  await expect(page.getByRole("article", { name: "Gebäude Hauptgebäude" })).toContainText(/Hauptgebäude · \d+ Räume/);

  // anlegen, Etage dazu, umbenennen
  const neu = page.getByRole("form", { name: "Neues Gebäude" });
  await neu.getByLabel("Gebäude").fill(BUILDING);
  await neu.getByRole("button", { name: "Gebäude anlegen" }).click();
  const card = page.getByRole("article", { name: `Gebäude ${BUILDING}` });
  await expect(card).toContainText("keine Räume");
  const floor = card.getByRole("form", { name: `Neue Etage in ${BUILDING}` });
  await floor.getByLabel("Neue Etage").fill("Erdgeschoss");
  await floor.getByRole("button", { name: "Etage anlegen" }).click();
  await expect(card.getByRole("form", { name: `Etage Erdgeschoss (${BUILDING})` })).toBeVisible();
  // doppelter Name (Schreibweise egal) → Meldung am Feld
  await neu.getByLabel("Gebäude").fill("hauptgebäude");
  await neu.getByRole("button", { name: "Gebäude anlegen" }).click();
  await expect(neu.getByText("Dieses Gebäude gibt es schon")).toBeVisible();
  await axeClean(page);

  // im Raumformular wählbar (Gebäude und Etage in einer Auswahl)
  await page.goto("/verwaltung/stammdaten/raeume/TH2");
  await expect(page.getByLabel("Gebäude und Etage")).toHaveValue(/^f:/);
  await expect(page.getByLabel("Gebäude und Etage").locator("option", { hasText: `${BUILDING} · Erdgeschoss` })).toHaveCount(1);

  // aufräumen: Etage und Gebäude löschen
  await page.goto("/verwaltung/stammdaten/raeume/gebaeude");
  await page.getByRole("button", { name: `Etage Erdgeschoss (${BUILDING}) löschen` }).click();
  await expect(page.getByRole("form", { name: `Etage Erdgeschoss (${BUILDING})` })).toHaveCount(0);
  await page.getByRole("button", { name: `Gebäude ${BUILDING} löschen` }).click();
  await expect(page.getByRole("article", { name: `Gebäude ${BUILDING}` })).toHaveCount(0);
  // mit Räumen: abgelehnt, mit Meldung
  await page.getByRole("button", { name: "Gebäude Pavillon löschen" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Noch 2 Räume in „Pavillon“" })).toBeVisible();
  expect(errors).toEqual([]);

  // Schülerin, schmal und dunkel: Raumfinder nach Gebäude, dann nach Etage
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const s = await narrow.newPage();
  const studentErrors = collectErrors(s);
  await login(s, "lea.schaefer");
  await s.goto("/raeume");
  await expect(s.getByRole("link", { name: "Türschilder drucken" })).toHaveCount(0);
  const finder = s.getByRole("search", { name: "Raumfinder" });
  await finder.getByLabel("Gebäude").selectOption({ label: "Pavillon" });
  await finder.getByRole("button", { name: "Suchen" }).click();
  await expect(s).toHaveURL(/gebaeude=/);
  await expect(s.getByRole("status").filter({ hasText: "2 Räume in Pavillon" })).toBeVisible();
  await expect(s.getByRole("link", { name: /^KU1/ })).toBeVisible();
  await expect(s.getByRole("link", { name: /^MU1/ })).toBeVisible();
  await expect(s.getByRole("link", { name: /^101/ })).toHaveCount(0);
  await s.goto("/raeume");
  await finder.getByLabel("Etage").selectOption({ label: "Naturwissenschaften · 1. OG" });
  await finder.getByRole("button", { name: "Suchen" }).click();
  await expect(s.getByRole("list", { name: "Naturwissenschaften, 1. OG" }).getByRole("link")).toHaveCount(1);
  await expect(s.getByRole("link", { name: /^NW3/ })).toBeVisible();
  await expect(s.getByRole("heading", { name: "1. OG", level: 3 })).toBeVisible();
  expect(await s.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(s);
  await s.screenshot({ path: ".data/shots/e2e/raumfinder-schuelerin-360-dunkel.png", fullPage: true });
  // Tür-QR gibt es für sie nicht
  await s.goto("/raeume/TH2");
  await expect(s.getByRole("article", { name: "Tür-QR" })).toHaveCount(0);
  expect((await s.request.get("/druck/tuerschilder?raum=TH2")).status()).toBe(404);
  expect((await s.request.get("/raeume/tuerschilder")).status()).toBe(404);
  expect(studentErrors).toEqual([]);
  await narrow.close();
});

test("RS-11: Tür-QR – Türschild drucken, abgemeldet nur Anmeldeseite (gültig = ungültig), danach Steckbrief, Neuerzeugen entwertet", async ({ page, browser }) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "sabine.kowalski");
  await page.goto("/raeume/TH2");
  const card = page.getByRole("article", { name: "Tür-QR" });
  await expect(card).toBeVisible();
  await axeClean(page);

  // Türschild drucken (A5, zwei je Blatt; A4 umschaltbar)
  await card.getByRole("link", { name: "Türschild drucken" }).click();
  await expect(page).toHaveURL(/\/druck\/tuerschilder\?raum=TH2$/);
  const sign = page.getByRole("article", { name: "Schild TH2" });
  await expect(sign).toContainText("Sporthalle 2");
  await expect(sign).toContainText("Sporthalle · EG");
  await expect(sign.getByRole("img", { name: /^QR-Code / })).toBeVisible();
  const url = (await sign.locator("figcaption").textContent())!.trim();
  const code = url.match(/\/r\/([0-9A-Z]{16})$/)?.[1];
  expect(code).toBeTruthy();
  await axeClean(page);
  await page.getByRole("link", { name: "A4 hoch (eins je Blatt)" }).click();
  await expect(page).toHaveURL(/format=a4/);
  await expect(page.getByRole("article", { name: "Schild TH2" }).locator("figcaption")).toHaveText(url);
  // Steckbrief zeigt jetzt die Kurz-URL
  await page.goto("/raeume/TH2");
  await expect(page.getByTestId("tuer-qr-url")).toHaveText(url);

  // Sammeldruck: Auswahl → Druckansicht mit zwei Schildern, Code von TH2 unverändert
  await page.goto("/raeume");
  await page.getByRole("link", { name: "Türschilder drucken" }).click();
  const pick = page.getByRole("form", { name: "Türschilder auswählen" });
  await pick.getByRole("checkbox", { name: /^TH1/ }).check();
  await pick.getByRole("checkbox", { name: /^TH2/ }).check();
  await pick.getByRole("button", { name: "Gewählte drucken" }).click();
  await expect(page.getByRole("article", { name: /^Schild / })).toHaveCount(2);
  await expect(page.getByRole("article", { name: "Schild TH2" }).locator("figcaption")).toHaveText(url);

  // abgemeldet: gültiger und ungültiger Code führen gleich auf die Anmeldeseite – ohne Rauminfo
  const anon = await browser.newContext();
  const a = await anon.newPage();
  const anonErrors = collectErrors(a);
  const valid = await a.goto(`/r/${code}`);
  await expect(a).toHaveURL(`/login?next=${encodeURIComponent(`/r/${code}`)}`);
  const validText = (await a.locator("main").innerText()).replaceAll(code!, "CODE");
  await expect(a.getByText(/TH2|Sporthalle/)).toHaveCount(0);
  const fake = "ZZZZZZZZZZZZZZZZ";
  const invalid = await a.goto(`/r/${fake}`);
  await expect(a).toHaveURL(`/login?next=${encodeURIComponent(`/r/${fake}`)}`);
  expect((await a.locator("main").innerText()).replaceAll(fake, "CODE")).toBe(validText);
  expect(invalid?.status()).toBe(valid?.status());
  // nach der Anmeldung: Steckbrief
  await a.goto(`/r/${code}`);
  await a.getByLabel("Benutzername").fill("lea.schaefer");
  await a.getByLabel("Passwort").fill(DEMO_PASSWORD);
  await a.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(a).toHaveURL("/raeume/TH2");
  await expect(a.getByRole("heading", { level: 1, name: "TH2 – Sporthalle 2" })).toBeVisible();
  // angemeldet: unbekannter Code → 404
  expect((await a.request.get(`/r/${fake}`)).status()).toBe(404);

  // neuen Code erzeugen: alter führt nirgends mehr hin, neuer auf den Steckbrief
  await page.goto("/raeume/TH2");
  await card.getByRole("button", { name: "Neuen Code erzeugen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Neuer Code erzeugt" })).toBeVisible();
  const fresh = (await page.getByTestId("tuer-qr-url").textContent())!.trim();
  expect(fresh).not.toBe(url);
  await expect(page.getByRole("article", { name: "Änderungen" })).toContainText("Tür-QR eines Raums neu erzeugt");
  expect((await a.request.get(`/r/${code}`)).status()).toBe(404);
  await a.goto(`/r/${fresh.split("/r/")[1]}`);
  await expect(a).toHaveURL("/raeume/TH2");
  expect(anonErrors).toEqual([]);
  await anon.close();
  expect(errors).toEqual([]);
});
