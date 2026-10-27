import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, publishIfDraft, sendPlannedNow } from "./helpers";

// VT-03a: Vertretungs-Arbeitsplatz dreiteilig – offene Stunden mit Ampel → gewählte Stunde per URL (Deeplink, Zurück-Taste) → Kontext
// (Tagesplan der Klasse, Tag der markierten Lehrkraft). Kopfleiste mit Tagwechsel, Zählern und „Gong geplant …“; aufgehobene
// Vertretung bleibt über „Verlauf ansehen“ erreichbar. Dazu 360 px ohne seitliches Scrollen und axe hell/dunkel. Ein Tag in drei
// Wochen, an dem BRA die 7b unterrichtet (fern von den Tagen anderer Specs); räumt am Ende auf.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).include("main").withTags(TAGS).analyze();
  expect(
    r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`)),
    `axe-Befunde auf ${where}`,
  ).toEqual([]);
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Tag mit diesem Wochentag (0 = Montag) in der dritten Woche ab heute. */
function weekdayInThreeWeeks(weekday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 21);
  while ((d.getDay() + 6) % 7 !== weekday) d.setDate(d.getDate() + 1);
  return ymd(d);
}

test("VT-03a: offene Stunde wählen → Formular und Kontext, Deeplink und Zurück, Kopfleiste, Aufgehoben mit Verlauf, mobil", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  const bra = page.getByRole("table", { name: "Stundenplan Klasse 7b" }).getByRole("link", { name: /BRA/ }).first();
  await expect(bra).toBeVisible();
  const weekday = await bra.evaluate((el) => {
    const td = el.closest("td")!;
    return Array.from(td.parentElement!.children).indexOf(td) - 1;
  });
  const date = weekdayInThreeWeeks(weekday);

  // Abwesenheit → offene Stunden mit Ampel (Tag in der Zukunft: „noch Zeit“)
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const dayNav = page.getByRole("navigation", { name: "Tagwechsel" });
  await expect(dayNav.getByRole("link", { name: /^Nächster Tag:/ })).toBeVisible();
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();
  await expect(page.getByRole("list", { name: "Tagesstand" })).toContainText(/\d+ offen/);
  const open = page.getByRole("table", { name: "Offene Stunden abwesender Lehrkräfte" });
  const row = open.getByRole("row").filter({ hasText: "Klasse 7b" }).filter({ hasText: "offen" }).first();
  await expect(row.getByText("noch Zeit")).toBeVisible();

  // gewählte Stunde per URL: Formular, Vorschläge, Kontext
  await row.getByRole("link", { name: "Vertretung eintragen" }).click();
  await expect(page).toHaveURL(/stunde=.+#lessons-title$/);
  const chosen = page.getByRole("article", { name: /^Gewählte Stunde: \d+\. Std · .+ · Klasse 7b$/ });
  await expect(chosen.getByRole("form")).toBeVisible();
  await expect(open.getByRole("row").and(page.locator('[aria-current="true"]'))).toHaveCount(1);
  const context = page.getByRole("region", { name: "Kontext" });
  await expect(context.getByRole("list", { name: "Tagesplan Klasse 7b" }).locator('[aria-current="true"]')).toHaveCount(1);
  const marks = context.getByRole("navigation", { name: "Lehrkraft markieren" }).getByRole("link");
  await expect(marks.first()).toHaveAttribute("aria-current", "true");
  await expect(context.getByRole("definition").first()).toContainText(/Stunde/);
  await expect(context).toContainText(/Hohlstunde|Randstunde|hat sonst frei/);
  await page.screenshot({ path: ".data/shots/e2e/vertretung-arbeitsplatz.png", fullPage: true });

  // andere Lehrkraft markieren → Deeplink mit `vorschlag`, Zurück-Taste stellt die vorige Auswahl her
  if ((await marks.count()) > 1) {
    const second = (await marks.nth(1).textContent())!.trim();
    await marks.nth(1).click();
    await expect(page).toHaveURL(/vorschlag=/);
    await expect(context.getByRole("heading", { name: `Tag von ${second}` })).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/vorschlag=/);
    await expect(marks.first()).toHaveAttribute("aria-current", "true");
  }

  // Vorschlag übernehmen → Stunde bleibt gewählt, Zeile „Vertretung“, Tag veröffentlichen → „Gong geplant …“ in der Kopfleiste
  const best = chosen.getByRole("group", { name: /^Vorschläge:/ }).getByRole("button", { name: /übernehmen/ }).first();
  const code = (await best.textContent())!.replace(" übernehmen", "").trim();
  await best.click();
  await expect(page).toHaveURL(/stunde=/);
  await expect(page.getByRole("region", { name: /^Alle Änderungen am/ }).getByRole("row").filter({ hasText: code }).first()).toBeVisible();
  await publishIfDraft(page);
  await expect(page.getByRole("list", { name: "Tagesstand" })).toContainText(/Gong (geplant .+|fällig) \(\d+\)/);
  await sendPlannedNow(page);

  // mobil 360 px, hell/dunkel: Spalten untereinander, keine seitliche Seite, axe ohne Befund
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const pErrors = collectErrors(p);
  const deeplink = page.url().replace(/[?&](veroeffentlicht|gesendet)=\d+/g, "");
  await p.goto(deeplink.includes("stunde=") ? deeplink : `/planung/vertretungen?datum=${date}`);
  await expect(p.getByRole("region", { name: /^Stunden am/ })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(p, "Vertretungs-Arbeitsplatz 360 px (hell)");
  await p.emulateMedia({ colorScheme: "dark" });
  await axeClean(p, "Vertretungs-Arbeitsplatz 360 px (dunkel)");
  expect(pErrors).toEqual([]);
  await narrow.close();
  await page.emulateMedia({ colorScheme: "dark" });
  await axeClean(page, "Vertretungs-Arbeitsplatz (dunkel)");
  await page.emulateMedia({ colorScheme: "light" });
  await axeClean(page, "Vertretungs-Arbeitsplatz (hell)");

  // aufräumen: Vertretungen des Tages aufheben → „Aufgehoben“ mit Verlauf, dann die Abwesenheit
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
  const buttons = day.getByRole("button", { name: /^Aufheben:/ });
  for (let n = await buttons.count(); n > 0; n--) {
    await buttons.first().click();
    await expect(buttons).toHaveCount(n - 1);
  }
  const removed = page.getByRole("list", { name: "Aufgehobene Änderungen" });
  await expect(removed.getByRole("listitem").first()).toContainText("aufgehoben");
  await removed.getByRole("link", { name: /^Verlauf ansehen:/ }).first().click();
  await expect(page).toHaveURL(/stunde=/);
  await expect(page.getByRole("article", { name: /^Gewählte Stunde:/ }).getByRole("list", { name: /^Verlauf:/ })).toContainText("aufgehoben");
  await page.getByRole("button", { name: "Abwesenheit BRA aufheben" }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();
  await sendPlannedNow(page);
  expect(errors).toEqual([]);
});
