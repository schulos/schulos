import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import AxeBuilder from "./axe";
import { collectErrors, login } from "./helpers";

// RS-06/RS-07: Gesamtablauf Raumsteckbrief mit Raumverantwortlichen. Fester Raum KU1 (im Demo-Seed ohne Verantwortliche und
// ohne Fotos), nicht vom heutigen Tag abhängig; der Test räumt Zuordnung, Foto, Menge und Infofelder wieder weg.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const NOTE = "Fachraumleitung Kunst (E2E)";
const AREA = "64 m² (E2E)";
const SAFETY = "Brennofen nur mit Aufsicht (E2E)";
const CAPTION = "Staffeleien am Fenster (E2E)";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function photo() {
  const buffer = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 150, b: 60 } } })
    .jpeg({ quality: 60 })
    .toBuffer();
  return { name: "kunstraum.jpg", mimeType: "image/jpeg", buffer };
}

test("RS-06/07: verantwortliche Lehrkraft pflegt ihren Raum (Foto, Ausstattung, Infofeld), fremden nicht; Schülerin sieht nur Öffentliches; 360 px dunkel; aufräumen", async ({
  page,
  browser,
}) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());

  // Sekretariat (Recht „Raumdaten pflegen“) trägt die Lehrkraft für KU1 ein
  await login(page, "sabine.kowalski");
  await page.goto("/raeume/KU1");
  const card = page.getByRole("article", { name: "Verantwortliche" });
  await expect(card.getByText("Niemand eingetragen.")).toBeVisible();
  await card.getByRole("link", { name: "Verantwortliche bearbeiten" }).click();
  await expect(page).toHaveURL(/\/raeume\/KU1\/verantwortliche$/);
  const add = page.getByRole("form", { name: "Verantwortliche eintragen" });
  await add.getByLabel("Person oder Gruppe").selectOption({ label: "Jana Brandt (BRA)" });
  await add.getByLabel("Aufgabe oder Kontakt (optional)").fill(NOTE);
  await add.getByRole("button", { name: "Eintragen" }).click();
  await expect(add.getByRole("status")).toHaveText("Verantwortliche eingetragen.");
  await expect(page.getByRole("listitem", { name: "Jana Brandt" })).toContainText(NOTE);
  await axeClean(page);

  // Lehrkraft, schmal und dunkel: sieht sich als verantwortlich und pflegt KU1 – aber keine Stammdaten, keine Zuordnungen
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const t = await narrow.newPage();
  const teacherErrors = collectErrors(t);
  t.on("dialog", (d) => void d.accept());
  await login(t, "jana.brandt");
  await t.goto("/raeume/KU1");
  await expect(t.getByRole("article", { name: "Verantwortliche" })).toContainText("Jana Brandt");
  await expect(t.getByRole("article", { name: "Verantwortliche" })).toContainText(NOTE);
  await expect(t.getByRole("link", { name: "Verantwortliche bearbeiten" })).toHaveCount(0);
  await expect(t.getByRole("link", { name: "Raum KU1 bearbeiten" })).toHaveCount(0);
  expect((await t.request.get("/raeume/KU1/verantwortliche")).status()).toBe(404);
  expect((await t.request.get("/verwaltung/stammdaten/raeume/KU1")).status()).toBe(404);

  // Foto
  await t.getByRole("link", { name: "Fotos bearbeiten" }).click();
  await expect(t).toHaveURL(/\/raeume\/KU1\/fotos$/);
  const upload = t.getByRole("form", { name: "Foto hochladen" });
  await upload.getByLabel("Foto", { exact: true }).setInputFiles(await photo());
  await upload.getByLabel("Bildunterschrift").fill(CAPTION);
  await upload.getByRole("button", { name: "Hochladen" }).click();
  await expect(upload.getByRole("status")).toHaveText("Foto hochgeladen.");

  // Ausstattung: Menge ändern
  await t.goto("/raeume/KU1/ausstattung");
  const amounts = t.getByRole("form", { name: "Mengen" });
  await expect(amounts.getByLabel("Waschbecken")).toHaveValue("2");
  await amounts.getByLabel("Waschbecken").fill("3");
  await amounts.getByRole("button", { name: "Mengen speichern" }).click();
  await expect(amounts.getByRole("status")).toHaveText("Mengen gespeichert.");

  // Infofelder: eines für alle, eines nur für Personal
  await t.goto("/raeume/KU1/infofelder");
  const info = t.getByRole("form", { name: "Infofelder" });
  await info.getByLabel("Fläche").fill(AREA);
  await info.getByLabel("Sicherheit").fill(SAFETY);
  await info.getByRole("button", { name: "Speichern" }).click();
  await expect(t).toHaveURL(/\/raeume\/KU1\?gespeichert=1/);
  await expect(t.getByRole("article", { name: "Infofelder" })).toContainText(SAFETY);
  await expect(t.getByRole("article", { name: "Überblick" }).getByText("3 × Waschbecken")).toBeVisible();

  // Historie: Vorgänge mit Feldnamen, ohne die Texte der Infofelder
  const history = t.getByRole("article", { name: "Änderungen" });
  await expect(history).toContainText("Infofelder eines Raums geändert");
  await expect(history).toContainText("Sicherheit");
  await expect(history).toContainText("Waschbecken: 2 → 3");
  await expect(history).toContainText("Raumfoto hochgeladen");
  await expect(history).toContainText("Raumverantwortliche eingetragen");
  await expect(history).not.toContainText("E2E)");
  expect(await t.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(t);
  await t.screenshot({ path: ".data/shots/e2e/raumverantwortliche-lehrkraft-360-dunkel.png", fullPage: true });

  // fremder Raum: weder Links noch Seiten noch Historie
  await t.goto("/raeume/MU1");
  await expect(t.getByRole("link", { name: "Infofelder bearbeiten" })).toHaveCount(0);
  await expect(t.getByRole("link", { name: "Fotos bearbeiten" })).toHaveCount(0);
  await expect(t.getByRole("link", { name: "Ausstattung bearbeiten" })).toHaveCount(0);
  await expect(t.getByRole("article", { name: "Änderungen" })).toHaveCount(0);
  for (const sub of ["infofelder", "fotos", "ausstattung"]) expect((await t.request.get(`/raeume/MU1/${sub}`)).status()).toBe(404);

  // Schülerin, schmal und dunkel: Titelbild, grobe Ausstattung, Infofeld „für alle“ – keine Personal-Angaben, keine Namen
  const narrowStudent = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const s = await narrowStudent.newPage();
  const studentErrors = collectErrors(s);
  await login(s, "lea.schaefer");
  await s.goto("/raeume/KU1");
  await expect(s.getByRole("article", { name: "Überblick" }).getByRole("img", { name: CAPTION })).toBeVisible();
  await expect(s.getByRole("article", { name: "Überblick" }).getByText("3 × Waschbecken")).toBeVisible();
  await expect(s.getByRole("article", { name: "Infofelder" })).toContainText(AREA);
  await expect(s.getByRole("article", { name: "Infofelder" })).not.toContainText(SAFETY);
  await expect(s.getByRole("article", { name: "Verantwortliche" })).toHaveCount(0);
  await expect(s.getByRole("article", { name: "Änderungen" })).toHaveCount(0);
  await expect(s.getByRole("article", { name: "Fotos" })).toHaveCount(0);
  await expect(s.getByText("Jana Brandt")).toHaveCount(0);
  await expect(s.getByRole("link", { name: /bearbeiten/ })).toHaveCount(0);
  for (const sub of ["infofelder", "fotos", "ausstattung", "verantwortliche"]) expect((await s.request.get(`/raeume/KU1/${sub}`)).status()).toBe(404);
  expect(await s.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(s);
  await s.screenshot({ path: ".data/shots/e2e/raumverantwortliche-schuelerin-360-dunkel.png", fullPage: true });
  await narrowStudent.close();

  // aufräumen (Lehrkraft): Foto löschen, Menge zurück, Infofelder leeren
  await t.goto("/raeume/KU1/fotos");
  await t.getByRole("button", { name: /^Foto 1.* löschen$/ }).click();
  await expect(t.getByRole("article", { name: "Vorhandene Fotos" }).getByText("Noch keine Fotos.")).toBeVisible();
  await t.goto("/raeume/KU1/ausstattung");
  await t.getByRole("form", { name: "Mengen" }).getByLabel("Waschbecken").fill("2");
  await t.getByRole("form", { name: "Mengen" }).getByRole("button", { name: "Mengen speichern" }).click();
  await expect(t.getByRole("form", { name: "Mengen" }).getByRole("status")).toHaveText("Mengen gespeichert.");
  await t.goto("/raeume/KU1/infofelder");
  await t.getByRole("form", { name: "Infofelder" }).getByLabel("Fläche").fill("");
  await t.getByRole("form", { name: "Infofelder" }).getByLabel("Sicherheit").fill("");
  await t.getByRole("form", { name: "Infofelder" }).getByRole("button", { name: "Speichern" }).click();
  await expect(t).toHaveURL(/\/raeume\/KU1\?gespeichert=1/);
  await expect(t.getByRole("article", { name: "Infofelder" })).not.toContainText("E2E)");
  await narrow.close();

  // aufräumen (Sekretariat): Zuordnung entfernen – danach pflegt die Lehrkraft KU1 nicht mehr
  await page.goto("/raeume/KU1/verantwortliche");
  await page.getByRole("button", { name: "Jana Brandt entfernen" }).click();
  await expect(page.getByText("Noch niemand eingetragen.")).toBeVisible();
  await page.goto("/raeume/KU1");
  await expect(page.getByRole("article", { name: "Änderungen" })).toContainText("Raumverantwortliche entfernt");
  await axeClean(page);
  expect([...errors, ...teacherErrors, ...studentErrors]).toEqual([]);
});
