import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { collectErrors, login } from "./helpers";

// RS-04/RS-05: Raumfotos (Titelbild für alle, Galerie für Personal) und selbstwachsender Ausstattungskatalog. Feste Räume
// (MU1 für Fotos, 015 und BIB für Ausstattung), fester Samstag für die Raumsuche – nicht vom heutigen Tag abhängig; jeder
// Test räumt seine Fotos bzw. Einträge wieder weg.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const ITEM = "Lötstation (E2E)";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Kleines Testbild mit EXIF (Name im Feld „Artist“), das der Server entfernen muss. */
async function testPhoto(name: string, color: { r: number; g: number; b: number }) {
  const buffer = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: color } })
    .withExif({ IFD0: { Artist: "Max Mustermann" } })
    .jpeg({ quality: 60 })
    .toBuffer();
  return { name, mimeType: "image/jpeg", buffer };
}

test("RS-04: Fotos hochladen (verkleinert, ohne EXIF), Titelbild für alle, Galerie nur Personal; 360 px dunkel; aufräumen", async ({ page, browser }) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "sabine.kowalski");
  await page.goto("/raeume/MU1");
  await page.getByRole("link", { name: "Fotos bearbeiten" }).click();
  await expect(page).toHaveURL(/\/raeume\/MU1\/fotos$/);
  const upload = page.getByRole("form", { name: "Foto hochladen" });
  await expect(upload.getByRole("note")).toContainText("keine Personen");
  await upload.getByLabel("Foto", { exact: true }).setInputFiles(await testPhoto("musikraum.jpg", { r: 40, g: 90, b: 160 }));
  await upload.getByLabel("Bildunterschrift").fill("Blick zum Flügel");
  await upload.getByRole("button", { name: "Hochladen" }).click();
  await expect(upload.getByRole("status")).toHaveText("Foto hochgeladen.");
  const list = page.getByRole("article", { name: "Vorhandene Fotos" });
  await expect(list.getByText("1600 × 1200 px")).toBeVisible();
  await expect(list.getByText("Titelbild", { exact: true })).toBeVisible();
  // zweites Foto: nur Galerie
  await upload.getByLabel("Foto", { exact: true }).setInputFiles(await testPhoto("regal.jpg", { r: 160, g: 120, b: 40 }));
  await upload.getByRole("button", { name: "Hochladen" }).click();
  await expect(list.getByText("1600 × 1200 px")).toHaveCount(2);
  await axeClean(page);

  // Steckbrief: Titelbild im Kopf, Galerie mit beiden Fotos; die Auslieferung enthält kein EXIF mehr
  await page.goto("/raeume/MU1");
  const cover = page.getByRole("article", { name: "Überblick" }).getByRole("img", { name: "Blick zum Flügel" });
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  const gallery = page.getByRole("article", { name: "Fotos" });
  await expect(gallery.getByRole("img")).toHaveCount(2);
  const coverSrc = (await cover.getAttribute("src"))!;
  const otherSrc = (await gallery.getByRole("img").nth(1).getAttribute("src"))!.replace("?klein=1", "");
  const res = await page.request.get(coverSrc);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/jpeg");
  const body = await res.body();
  expect(body.includes("Mustermann")).toBe(false);
  expect(body.includes("Exif")).toBe(false);
  await axeClean(page);

  // Schülerin: Titelbild (Raumliste und Kopf), keine Galerie; Galerie-Foto per Adresse 404
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  await login(p, "lea.schaefer");
  await p.goto("/raeume?q=MU1");
  await expect(p.getByRole("link", { name: /^MU1/ }).locator("img")).toHaveCount(1);
  await p.goto("/raeume/MU1");
  await expect(p.getByRole("article", { name: "Überblick" }).getByRole("img", { name: "Blick zum Flügel" })).toBeVisible();
  await expect(p.getByRole("article", { name: "Fotos" })).toHaveCount(0);
  await expect(p.getByRole("link", { name: "Fotos bearbeiten" })).toHaveCount(0);
  expect((await p.request.get(coverSrc)).status()).toBe(200);
  expect((await p.request.get(otherSrc)).status()).toBe(404);
  expect((await p.request.get("/raeume/MU1/fotos")).status()).toBe(404);
  await p.goto("/raeume/MU1");
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await p.screenshot({ path: ".data/shots/e2e/raumfotos-schuelerin-360-dunkel.png", fullPage: true });
  await narrow.close();

  // aufräumen: beide Fotos löschen
  await page.goto("/raeume/MU1/fotos");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: /^Foto 1.* löschen$/ }).click();
    await expect(page.getByText("1600 × 1200 px")).toHaveCount(1 - i);
  }
  await expect(page.getByRole("article", { name: "Vorhandene Fotos" }).getByText("Noch keine Fotos.")).toBeVisible();
  expect([...errors, ...narrowErrors]).toEqual([]);
});

test("RS-05: Ausstattung per Typeahead neu anlegen, am zweiten Raum aus dem Katalog wählen, Raumsuche; 360 px dunkel; aufräumen", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/raeume/015");
  await page.getByRole("link", { name: "Ausstattung bearbeiten" }).click();
  await expect(page).toHaveURL(/\/raeume\/015\/ausstattung$/);
  // neu: noch nicht im Katalog
  await expect(page.locator(`datalist#ausstattung-katalog option[value="${ITEM}"]`)).toHaveCount(0);
  await expect(page.locator("datalist#ausstattung-katalog option[value='Beamer']")).toHaveCount(1);
  const add = page.getByRole("form", { name: "Ausstattung eintragen" });
  await add.getByLabel("Ausstattung", { exact: true }).fill(`  ${ITEM} `);
  await add.getByLabel("Menge").fill("3");
  await add.getByRole("button", { name: "Eintragen" }).click();
  await expect(add.getByRole("status")).toHaveText("Ausstattung eingetragen.");
  await expect(page.getByRole("form", { name: "Mengen" }).getByLabel(ITEM)).toHaveValue("3");
  await axeClean(page);

  // zweiter Raum: der neue Eintrag steht im Typeahead; andere Schreibweise ergibt denselben Katalogeintrag
  await page.goto("/raeume/BIB/ausstattung");
  await expect(page.locator(`datalist#ausstattung-katalog option[value="${ITEM}"]`)).toHaveCount(1);
  await page.getByRole("form", { name: "Ausstattung eintragen" }).getByLabel("Ausstattung", { exact: true }).fill(ITEM.toLowerCase());
  await page.getByRole("form", { name: "Ausstattung eintragen" }).getByRole("button", { name: "Eintragen" }).click();
  await expect(page.getByRole("form", { name: "Mengen" }).getByLabel(ITEM)).toHaveValue("1");

  // Katalog: genau ein Eintrag, zwei Räume
  await page.goto("/verwaltung/stammdaten/raeume/ausstattung");
  const entry = page.getByRole("listitem", { name: ITEM });
  await expect(entry).toHaveCount(1);
  await expect(entry.getByText("2 Räume")).toBeVisible();
  await axeClean(page);

  // Steckbrief und Raumsuche (Samstag: alle Räume frei)
  await page.goto("/raeume/015");
  await expect(page.getByRole("article", { name: "Überblick" }).getByText(`3 × ${ITEM}`)).toBeVisible();
  await page.goto("/stundenplan/raeume?datum=2027-03-06&von=1");
  const search = page.getByRole("form", { name: "Raumsuche" });
  await search.getByLabel(ITEM).check();
  await search.getByRole("button", { name: "Freie Räume suchen" }).click();
  await expect(page.getByRole("heading", { name: /^2 Räume frei/ })).toBeVisible();
  const hits = page.getByRole("table", { name: "Freie Räume" });
  await expect(hits.getByRole("link", { name: "015", exact: true })).toBeVisible();
  await expect(hits.getByRole("link", { name: "BIB", exact: true })).toBeVisible();

  // Schülerin sieht die grobe Ausstattung, pflegt aber nicht; schmal und dunkel
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const p = await narrow.newPage();
  const narrowErrors = collectErrors(p);
  await login(p, "lea.schaefer");
  await p.goto("/raeume/015");
  await expect(p.getByRole("article", { name: "Überblick" }).getByText(`3 × ${ITEM}`)).toBeVisible();
  await expect(p.getByRole("link", { name: "Ausstattung bearbeiten" })).toHaveCount(0);
  expect((await p.request.get("/raeume/015/ausstattung")).status()).toBe(404);
  await p.goto("/raeume/015");
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p);
  await narrow.close();

  // aufräumen: Menge 0 in beiden Räumen, dann den nun unbenutzten Eintrag löschen
  for (const room of ["015", "BIB"]) {
    await page.goto(`/raeume/${room}/ausstattung`);
    const form = page.getByRole("form", { name: "Mengen" });
    await form.getByLabel(ITEM).fill("0");
    await form.getByRole("button", { name: "Mengen speichern" }).click();
    await expect(form.getByRole("status")).toHaveText("Mengen gespeichert.");
    await expect(page.getByRole("form", { name: "Mengen" }).getByLabel(ITEM)).toHaveCount(0);
  }
  await page.goto("/verwaltung/stammdaten/raeume/ausstattung");
  await page.getByRole("button", { name: `${ITEM} aus dem Katalog löschen` }).click();
  await expect(page.getByRole("listitem", { name: ITEM })).toHaveCount(0);
  expect([...errors, ...narrowErrors]).toEqual([]);
});
