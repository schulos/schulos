import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, publishIfDraft } from "./helpers";

// VT-02: Anzeige überall – „nur Betreuung“ mit Grund und internem Hinweis eintragen (Planung), Monitor zeigt „Betreuung“ und den
// Grund, nie den internen Hinweis; die Vertretungslehrkraft sieht ihn in „Meine Vertretungen“ und bestätigt mit „Gesehen“, die
// Planung sieht in der gewählten Stunde (VT-03a) „offen“ → „gesehen“ und den Verlauf. Dazu 360 px ohne seitliches Scrollen und axe hell/dunkel.
// Räumt am Ende auf (Klasse 10a, nächster Schultag).

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).include("main").withTags(TAGS).analyze();
  expect(
    r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`)),
    `axe-Befunde auf ${where}`,
  ).toEqual([]);
}

/** Die beiden Tage des Vertretungsplans wie `planDays()`: heute (Berlin; am Wochenende der Montag) und der Schultag danach. */
function planDaysBerlin(): [string, string] {
  const [y, m, day] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date()).split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1, day!, 12));
  const skipWeekend = () => {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  };
  skipWeekend();
  const first = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 1);
  skipWeekend();
  return [first, d.toISOString().slice(0, 10)];
}

test("VT-02: Betreuung mit Grund, interner Hinweis nur für Vertretung und Planung, Kenntnisnahme, Verlauf", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const NOTE = "VT02-E2E Lesetext";
  const SECRET = "VT02-E2E intern";
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  // Welche Stunden der 10a für BRA (jana.brandt) frei sind, hängt vom Wochentag ab (mittwochs ist BRA in allen 10a-Stunden gebunden).
  // Deshalb nicht den Vorgabetag der Seite nehmen, sondern beide Tage des Vertretungsplans (heute bzw. nächster Schultag und der
  // Schultag danach) durchsuchen.
  let label: string | null = null;
  for (const candidate of planDaysBerlin()) {
    await page.goto(`/planung/vertretungen?datum=${candidate}&gruppe=g-10a`);
    const forms = page.getByRole("form", { name: /^\d+\. Std · .+ · Klasse 10a$/ });
    await expect(forms.first()).toBeVisible();
    for (let i = 0; i < (await forms.count()); i++) {
      const f = forms.nth(i);
      if ((await f.locator('optgroup[label="Frei"] option').filter({ hasText: /^BRA – / }).count()) > 0) {
        label = await f.getAttribute("aria-label");
        break;
      }
    }
    if (label) break;
  }
  expect(label, "Stunde der 10a mit freier Lehrkraft BRA an einem der beiden Plantage").not.toBeNull();
  const form = page.getByRole("form", { name: label! });
  await form.getByRole("radio", { name: "Vertretung", exact: true }).check();
  await form.getByLabel("Vertretung durch").selectOption({ label: (await form.locator('optgroup[label="Frei"] option').filter({ hasText: /^BRA – / }).first().textContent())! });
  await form.getByLabel("Grund (öffentlich)").selectOption({ label: "organisatorisch" });
  await form.getByLabel("Hinweis für Schüler:innen").fill(NOTE);
  await form.getByLabel("Interne Notiz (nur Planung und Vertretung)").fill(SECRET);
  await form.getByRole("radio", { name: "Nur Betreuung" }).check();
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await publishIfDraft(page);

  const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
  const row = day.getByRole("row").filter({ hasText: NOTE });
  await expect(row).toContainText("Betreuung");
  await expect(row).toContainText("organisatorisch");
  await expect(page.getByRole("article", { name: /^Noch nicht bestätigt/ })).toContainText("durch BRA");
  // VT-03a: Kenntnisnahme und Verlauf je Stunde (nur Planung) stehen in der gewählten Stunde
  await row.getByRole("link", { name: /^Stunde öffnen:/ }).click();
  await expect(page).toHaveURL(/stunde=/);
  const chosen = page.getByRole("article", { name: /^Gewählte Stunde:/ });
  await expect(chosen.getByText("offen", { exact: true })).toBeVisible();
  await expect(chosen.getByRole("list", { name: /^Verlauf:/ })).toContainText("angelegt");

  // Monitor: Betreuung und Grund ja, interner Hinweis nie
  const mctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const monitor = await mctx.newPage();
  await monitor.goto("/monitor/demo-foyer-lindenhof-2026");
  const mrow = monitor.getByRole("row").filter({ hasText: NOTE }).first();
  await expect(mrow).toContainText("Betreuung");
  await expect(mrow).toContainText("organisatorisch");
  await expect(monitor.getByText(SECRET)).toHaveCount(0);
  await mctx.close();

  // Vertretungslehrkraft: „Meine Vertretungen“ mit internem Hinweis, mobil 360 px, axe hell/dunkel, dann „Gesehen“
  const tctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const teacher = await tctx.newPage();
  const teacherErrors = collectErrors(teacher);
  await login(teacher, "jana.brandt");
  await teacher.goto("/stundenplan/vertretungen");
  const own = teacher.getByRole("article", { name: "Meine Vertretungen" });
  await expect(own).toContainText(SECRET);
  await expect(own).toContainText("Betreuung");
  expect(await teacher.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(teacher, "Vertretungsplan Lehrkraft (hell)");
  await teacher.emulateMedia({ colorScheme: "dark" });
  await axeClean(teacher, "Vertretungsplan Lehrkraft (dunkel)");
  await teacher.emulateMedia({ colorScheme: "light" });
  const item = own.getByRole("listitem").filter({ hasText: NOTE });
  await item.getByRole("button", { name: /^Gesehen:/ }).click();
  await expect(item.getByText("Gesehen", { exact: true })).toBeVisible();
  expect(teacherErrors).toEqual([]);
  await tctx.close();

  // Planung: jetzt „gesehen“
  await page.reload();
  await expect(chosen.getByText("gesehen", { exact: true })).toBeVisible();

  // aufräumen
  await day.getByRole("row").filter({ hasText: NOTE }).getByRole("button", { name: /^Aufheben:/ }).click();
  await expect(day.getByText(NOTE)).toHaveCount(0);
  expect(errors).toEqual([]);
});
