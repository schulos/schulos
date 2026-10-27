import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// VT-03b: Vorschlagskarten mit Hauptknopf und aufklappbaren Gründen, kompaktes Formular mit Segment-Schalter (nur die passenden Felder),
// Tastatur (↑/↓ durch die offenen Stunden, 1–3 Vorschlag übernehmen, Esc) nur ohne Eingabefeld und abschaltbar, Speichern → nächste
// offene Stunde, Material auch ohne Abwesenheit. Dazu 360 px ohne seitliches Scrollen und axe hell/dunkel. Ein Tag in vier Wochen (BRA
// unterrichtet dort die 7b), ein zweiter eine Woche später ohne Abwesenheit für das Material; räumt am Ende auf.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).include("main").withTags(TAGS).analyze();
  expect(
    r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`)),
    `axe-Befunde auf ${where}`,
  ).toEqual([]);
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Tag mit diesem Wochentag (0 = Montag) frühestens `days` Tage ab heute. */
function weekdayAfter(days: number, weekday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  while ((d.getDay() + 6) % 7 !== weekday) d.setDate(d.getDate() + 1);
  return ymd(d);
}

const stundeOf = (url: string) => new URL(url).searchParams.get("stunde");

test("VT-03b: Vorschlagskarten, Segment-Schalter, Tastatur, nächste offene Stunde, Material ohne Abwesenheit, mobil", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  const bra = page.getByRole("table", { name: "Stundenplan Klasse 7b" }).getByRole("link", { name: /BRA/ }).first();
  await expect(bra).toBeVisible();
  const weekday = await bra.evaluate((el) => {
    const td = el.closest("td")!;
    return Array.from(td.parentElement!.children).indexOf(td) - 1;
  });
  const date = weekdayAfter(28, weekday);
  const quietDate = weekdayAfter(35, weekday);

  // Abwesenheit → mindestens drei offene Stunden
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();
  const open = page.getByRole("table", { name: "Offene Stunden abwesender Lehrkräfte" });
  const openRows = open.getByRole("row").filter({ hasText: "offen" });
  expect(await openRows.count(), "BRA hat an dem Tag mindestens drei Stunden").toBeGreaterThanOrEqual(3);
  await openRows.first().getByRole("link", { name: "Vertretung eintragen" }).click();
  const chosen = page.getByRole("article", { name: /^Gewählte Stunde:/ });
  await expect(chosen).toBeVisible();
  const first = stundeOf(page.url());
  expect(first).toBeTruthy();

  // Vorschlagskarten: Hauptknopf mit Taste 1, Gründe aufklappbar, Punkte
  const cards = chosen.getByRole("group", { name: /^Vorschläge:/ }).getByRole("list").first().getByRole("listitem");
  await expect(cards.first()).toBeVisible();
  const main = cards.first().getByRole("button", { name: /übernehmen:/ }).first();
  await expect(main).toHaveAttribute("aria-keyshortcuts", "1");
  await expect(cards.first().getByText(/Punkte$/)).toBeVisible();
  const reasons = cards.first().getByRole("list", { name: /^Gründe:/ });
  await expect(reasons).toBeHidden();
  await cards.first().getByText(/^Gründe \(\d+\)$/).click();
  await expect(reasons).toBeVisible();
  await expect(chosen.getByRole("link", { name: /^Tag von / }).first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/vertretung-vorschlagskarten.png", fullPage: true });

  // Tastenkürzel sind erklärt, und die Ziele tragen aria-keyshortcuts
  const help = page.getByText("Tastenkürzel", { exact: true });
  await help.click();
  await expect(page.getByText(/vorherige\/nächste offene Stunde/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Nächste offene Stunde/ })).toHaveAttribute("aria-keyshortcuts", "ArrowDown");
  await expect(page.getByRole("link", { name: "Stunde schließen" })).toHaveAttribute("aria-keyshortcuts", "Escape");

  // Segment-Schalter: nur die passenden Felder
  const lessonForm = chosen.getByRole("form");
  await expect(lessonForm.getByLabel("Vertretung durch")).toBeVisible();
  await expect(lessonForm.getByLabel("Fach", { exact: true })).toBeVisible();
  await lessonForm.getByRole("radio", { name: "Entfall" }).check();
  await expect(lessonForm.getByLabel("Vertretung durch")).toHaveCount(0);
  await expect(lessonForm.getByLabel("Raum", { exact: true })).toHaveCount(0);
  await lessonForm.getByRole("radio", { name: "Verlegung" }).check();
  await expect(lessonForm.getByLabel("Verlegen in")).toBeVisible();
  await lessonForm.getByRole("radio", { name: "Zusammenlegung" }).check();
  await expect(lessonForm.getByLabel("Zusammenlegen mit")).toBeVisible();
  await lessonForm.getByRole("radio", { name: "Nur Betreuung" }).check();
  await expect(lessonForm.getByLabel("Vertretung durch")).toBeVisible();
  await expect(lessonForm.getByLabel("Fach", { exact: true })).toHaveCount(0);
  await lessonForm.getByRole("radio", { name: "Vertretung", exact: true }).check();
  await expect(lessonForm.getByLabel("Fach", { exact: true })).toBeVisible();
  await expect(lessonForm.getByLabel("Grund (öffentlich)")).toBeVisible();
  await expect(lessonForm.getByLabel("Interne Notiz (nur Planung und Vertretung)")).toBeVisible();

  // Tastatur im Eingabefeld: „1“ und Pfeile gehören dem Feld
  const note = lessonForm.getByLabel("Hinweis für Schüler:innen");
  await note.focus();
  await page.keyboard.type("1");
  await page.keyboard.press("ArrowDown");
  await expect(note).toHaveValue("1");
  expect(stundeOf(page.url())).toBe(first);
  await expect(chosen.getByRole("form")).toBeVisible();
  await note.fill("");
  await note.blur();
  await page.locator("body").click({ position: { x: 1, y: 1 } });

  // ↓ nächste offene Stunde, ↑ zurück
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => stundeOf(page.url())).not.toBe(first);
  const second = stundeOf(page.url());
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => stundeOf(page.url())).toBe(first);

  // abschalten: Pfeil tut nichts, wieder anschalten
  await page.getByLabel("Tastenkürzel verwenden").uncheck();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  expect(stundeOf(page.url())).toBe(first);
  await page.getByLabel("Tastenkürzel verwenden").check();
  await page.locator("body").click({ position: { x: 1, y: 1 } });

  // 1 = ersten Vorschlag übernehmen → nächste offene Stunde mit Hinweis, Änderung steht in „Alle Änderungen“
  const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
  const before = await day.getByRole("row").count();
  await page.keyboard.press("1");
  await expect.poll(() => stundeOf(page.url())).not.toBe(first);
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert – das ist die nächste offene Stunde." })).toBeVisible();
  await expect.poll(() => day.getByRole("row").count()).toBeGreaterThan(before);
  expect(stundeOf(page.url())).toBe(second);

  // Formular: Entfall speichern → weiter zur nächsten offenen Stunde
  const next = page.getByRole("article", { name: /^Gewählte Stunde:/ });
  await next.getByRole("form").getByRole("radio", { name: "Entfall" }).check();
  await next.getByRole("form").getByLabel("Grund (öffentlich)").selectOption({ label: "Veranstaltung" });
  const afterSecond = stundeOf(page.url());
  await next.getByRole("form").getByRole("button", { name: "Speichern" }).click();
  await expect.poll(() => stundeOf(page.url())).not.toBe(afterSecond);
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert – das ist die nächste offene Stunde." })).toBeVisible();

  // mobil 360 px und axe, hell/dunkel
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const pErrors = collectErrors(p);
  await p.goto(page.url());
  await expect(p.getByRole("region", { name: /^Stunden am/ })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p, "Vorschlagskarten 360 px (hell)");
  await p.emulateMedia({ colorScheme: "dark" });
  await axeClean(p, "Vorschlagskarten 360 px (dunkel)");
  expect(pErrors).toEqual([]);
  await narrow.close();
  await page.emulateMedia({ colorScheme: "dark" });
  await axeClean(page, "Vorschlagskarten (dunkel)");
  await page.emulateMedia({ colorScheme: "light" });
  await axeClean(page, "Vorschlagskarten (hell)");

  // Esc schließt die Stunde
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Escape");
  await expect.poll(() => stundeOf(page.url())).toBeNull();

  // aufräumen: Änderungen des Tages aufheben, Abwesenheit entfernen
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const buttons = page.getByRole("region", { name: /^Alle Änderungen am/ }).getByRole("button", { name: /^Aufheben:/ });
  for (let n = await buttons.count(); n > 0; n--) {
    await buttons.first().click();
    await expect(buttons).toHaveCount(n - 1);
  }
  await page.getByRole("button", { name: "Abwesenheit BRA aufheben" }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();

  // Material ohne Abwesenheit: Tag ohne Abwesenheit, Stunde wählen, Auftrag speichern, danach „liegt vor“, wieder löschen
  await page.goto(`/planung/vertretungen?gruppe=g-7b&datum=${quietDate}`);
  await page.getByRole("link", { name: /^Stunde wählen:/ }).first().click();
  const lesson = page.getByRole("article", { name: /^Gewählte Stunde:/ });
  await expect(lesson).toBeVisible();
  await lesson.getByText(/^Material für die Vertretung/).click();
  const material = lesson.getByRole("form", { name: /^Material / });
  await material.getByLabel("Arbeitsauftrag").fill("Buch S. 34, Nr. 1–4");
  await material.getByRole("button", { name: "Material speichern" }).click();
  await expect(material.getByRole("status")).toContainText("Material gespeichert.");
  await page.reload();
  await expect(page.getByRole("article", { name: /^Gewählte Stunde:/ }).getByText("Material für die Vertretung (liegt vor)")).toBeVisible();
  const again = page.getByRole("article", { name: /^Gewählte Stunde:/ }).getByRole("form", { name: /^Material / });
  await expect(again.getByLabel("Arbeitsauftrag")).toHaveValue("Buch S. 34, Nr. 1–4");
  await again.getByLabel("Arbeitsauftrag").fill("");
  await again.getByRole("button", { name: "Material speichern" }).click();
  await expect(again.getByRole("status")).toContainText("Material gelöscht.");
  expect(errors).toEqual([]);
});
