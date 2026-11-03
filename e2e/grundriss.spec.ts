import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import AxeBuilder from "./axe";
import { collectErrors, login } from "./helpers";

// RS-13: Grundriss je Etage. Sekretariat (verwaltung.school) lädt einen Plan für Hauptgebäude · 2. OG hoch, verortet Räume per
// Tastatur (Pfeiltasten), per Zahlenfeld und per Klick; Schülerin sieht den Plan im Raumfinder (360 px, dunkel, axe) und die
// „Lage“ im Steckbrief; Moduleinstellung „nur Personal“ blendet ihn für sie aus; ohne Anmeldung liefert die Route nichts.
// Feste Etage 2. OG (Räume 301–306, sonst in keinem Spec mit Grundriss); der Plan wird am Ende gelöscht.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const SETTING = "Grundriss je Etage: wer sieht ihn";
const EDIT = "/verwaltung/stammdaten/raeume/gebaeude";

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function planPng(): Promise<Buffer> {
  // heller Plan mit zwei „Fluren“ – reicht als Bild; Metadaten entfernt der Server ohnehin
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#fafafa"/><rect x="40" y="260" width="1120" height="80" fill="#ddd"/><rect x="560" y="40" width="80" height="520" fill="#ddd"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

test("RS-13: Grundriss hochladen, Räume per Tastatur/Zahl/Klick verorten, Raumfinder und Lage (Schülerin 360 px dunkel), nur Personal, aufräumen", async ({ page, browser }) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "sabine.kowalski");
  await page.goto(EDIT);
  await page.getByRole("link", { name: "Grundriss hochladen: Hauptgebäude · 2. OG" }).click();
  await expect(page.getByRole("heading", { name: "Grundriss Hauptgebäude · 2. OG" })).toBeVisible();
  await expect(page.getByText("Nicht als Flucht- und Rettungsplan verwenden.").first()).toBeVisible();
  await expect(page.getByText("keine Personen und keine Namensschilder")).toBeVisible();
  const floorUrl = page.url();

  // Hochladen: Alternativtext zu kurz → Meldung am Feld; dann richtig
  const upload = page.getByRole("form", { name: "Grundriss hochladen" });
  const png = { name: "plan.png", mimeType: "image/png", buffer: await planPng() };
  await upload.getByLabel("Bild des Grundrisses").setInputFiles(png);
  await upload.getByLabel("Alternativtext (Pflicht)").fill("Flur");
  await upload.getByLabel("Alternativtext (Pflicht)").evaluate((el) => el.removeAttribute("minlength"));
  await upload.getByRole("button", { name: "Hochladen" }).click();
  await expect(upload.getByRole("alert")).toContainText("mindestens 10 Zeichen");
  await upload.getByLabel("Bild des Grundrisses").setInputFiles(png);
  await upload.getByLabel("Alternativtext (Pflicht)").fill("Langer Flur von West nach Ost, Treppenhaus in der Mitte");
  await upload.getByRole("button", { name: "Hochladen" }).click();
  await expect(page.getByRole("form", { name: "Räume auf dem Grundriss verorten" })).toBeVisible();

  const editor = page.getByRole("form", { name: "Räume auf dem Grundriss verorten" });
  // per Tastatur: Raum 305 wählen, Punkt fokussieren, Umschalt+Pfeil links ×4 → 30 % von links, 50 % von oben
  await editor.getByLabel("Raum", { exact: true }).selectOption("305");
  const marker = editor.getByRole("button", { name: /Punkt für Raum 305/ });
  await marker.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect(editor.getByText("Raum 305: 30 % von links, 50 % von oben – noch nicht gespeichert.")).toBeVisible();
  await expect(editor.getByLabel("Von links (%)")).toHaveValue("30");
  await editor.getByRole("button", { name: "Punkt speichern" }).click();
  await expect(editor.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
  const list = page.getByRole("article", { name: "Räume dieser Etage" });
  await expect(list.getByRole("listitem").filter({ hasText: "305" })).toContainText("30 % von links, 50 % von oben");

  // per Zahlenfeld: Raum 306
  await editor.getByLabel("Raum", { exact: true }).selectOption("306");
  await editor.getByLabel("Von links (%)").fill("70");
  await editor.getByLabel("Von oben (%)").fill("40");
  await editor.getByRole("button", { name: "Punkt speichern" }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "306" })).toContainText("70 % von links, 40 % von oben");

  // per Klick/Tippen: Raum 304
  await editor.getByLabel("Raum", { exact: true }).selectOption("304");
  const img = editor.getByRole("img", { name: /Grundriss Hauptgebäude · 2. OG/ });
  const box = (await img.boundingBox())!;
  await img.click({ position: { x: box.width * 0.2, y: box.height * 0.8 } });
  await expect(editor.getByText(/Raum 304: \d+(,\d)? % von links/)).toBeVisible();
  await editor.getByRole("button", { name: "Punkt speichern" }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "304" })).not.toContainText("noch nicht verortet");
  await axeClean(page);
  expect(errors).toEqual([]);

  // Schülerin, schmal und dunkel: Raumfinder nach Etage → Grundriss offen, Punkte als Links, Lage im Steckbrief
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark" });
  const s = await narrow.newPage();
  const studentErrors = collectErrors(s);
  await login(s, "lea.schaefer");
  await s.goto("/raeume");
  const finder = s.getByRole("search", { name: "Raumfinder" });
  await finder.getByLabel("Etage").selectOption({ label: "Hauptgebäude · 2. OG" });
  await finder.getByRole("button", { name: "Suchen" }).click();
  // die Liste bleibt Hauptansicht
  await expect(s.getByRole("list", { name: "Hauptgebäude, 2. OG" }).getByRole("link")).toHaveCount(6);
  const plan = s.getByRole("list", { name: "Räume auf dem Grundriss Hauptgebäude · 2. OG" });
  await expect(plan.getByRole("link")).toHaveCount(3);
  await expect(s.getByRole("img", { name: /Grundriss Hauptgebäude · 2. OG: Langer Flur/ })).toBeVisible();
  await expect(s.getByText("Nicht als Flucht- und Rettungsplan verwenden.")).toBeVisible();
  expect(await s.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(s);
  const src = (await s.getByRole("img", { name: /Grundriss Hauptgebäude · 2. OG/ }).getAttribute("src"))!;
  const res = await s.request.get(src);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/jpeg");
  await plan.getByRole("link", { name: "Raum 306" }).click();
  await expect(s).toHaveURL(/\/raeume\/306$/);
  const lage = s.getByRole("article", { name: "Lage" });
  await expect(lage).toContainText("Raum 306 ist auf dem Grundriss hervorgehoben");
  await expect(lage.getByRole("img", { name: "Raum 306" })).toBeVisible();
  await expect(lage.getByRole("link", { name: "Raum 305" })).toBeVisible();
  await expect(lage.getByRole("link", { name: "Grundriss bearbeiten" })).toHaveCount(0);
  await axeClean(s);

  // ohne Anmeldung: keine öffentliche URL
  const anon = await browser.newContext();
  const anonRes = await anon.request.get(src, { maxRedirects: 0 });
  expect(anonRes.status()).not.toBe(200);
  await anon.close();

  // Moduleinstellung „nur Personal“: Schülerin sieht weder Plan noch Datei, die Liste bleibt
  const admin = await (await browser.newContext()).newPage();
  await login(admin, "admin");
  await admin.goto("/verwaltung/rechte");
  await admin.getByLabel(SETTING).selectOption({ label: "nur Personal" });
  await expect(admin.getByLabel(SETTING)).toHaveValue("personal");
  await admin.reload();
  await expect(admin.getByLabel(SETTING)).toHaveValue("personal");
  await s.goto("/raeume/306");
  await expect(s.getByRole("article", { name: "Lage" })).toHaveCount(0);
  expect((await s.request.get(src)).status()).toBe(404);
  await s.goto("/raeume");
  await expect(s.getByText(/^Grundriss Hauptgebäude/)).toHaveCount(0);
  await admin.getByLabel(SETTING).selectOption({ label: "alle Angemeldeten (Vorgabe)" });
  await expect(admin.getByLabel(SETTING)).toHaveValue("alle");
  await admin.reload();
  await expect(admin.getByLabel(SETTING)).toHaveValue("alle");
  await admin.context().close();
  expect(studentErrors).toEqual([]);
  await narrow.close();

  // aufräumen: Plan löschen entfernt auch die Punkte
  await page.goto(floorUrl);
  await page.getByRole("button", { name: "Grundriss löschen" }).click();
  await expect(page.getByRole("form", { name: "Grundriss hochladen" })).toBeVisible();
  await page.goto(EDIT);
  await expect(page.getByRole("link", { name: "Grundriss hochladen: Hauptgebäude · 2. OG" })).toBeVisible();
  expect(errors).toEqual([]);
});
