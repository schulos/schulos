import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { approveVersion, collectErrors, deDate, login, undoAndDiscardVersion } from "./helpers";

// SP3-04: Veröffentlichen einer freigegebenen Version ab Stichtag – Planung (frank.schulte) ändert im Entwurf den Raum einer Deutsch-Stunde
// der 7b (Jana Brandt), die Schulleitung gibt frei; Vorschau der Veröffentlichung mit Zahlen → „Ab … veröffentlichen“ → der Entfall am
// Stichtag zieht an die neue Stunde mit → die Lehrkraft bekommt die Änderungsliste sofort (Gong), die Schülerin erst am Vortag → „Plan am
// Tag X“ (Datumswähler in Plan und Druck) vor/nach dem Stichtag → Hinweis im Vertretungs-Arbeitsplatz solange freigegeben (R2) →
// zurücknehmen → alter Stand, Entfall wieder an der alten Stunde. Veröffentlichungsseite und Plan mit axe, schmal (360 px) und dunkel.
const tag = Date.now().toString(36);
const NAME = `E2E Veröffentlichen ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mondayIn(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return ymd(d);
}
const plus = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return ymd(d);
};

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function as(browser: Browser, user: string, opts: { width?: number } = {}) {
  const ctx = await browser.newContext(opts.width ? { viewport: { width: opts.width, height: 800 } } : {});
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { page, errors, close: () => ctx.close() };
}

test("SP3-04: freigegebene Version → Vorschau → veröffentlichen ab Stichtag → Vertretung zieht um → Gong → Plan am Tag X → zurücknehmen", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  const cutoff = mondayIn(7);

  // Entwurf aus dem gültigen Plan ab Stichtag; im Entwurf den Raum einer Deutsch-Stunde der 7b ändern
  await page.goto("/planung/versionen");
  const form = page.getByRole("form", { name: "Entwurf anlegen" });
  await form.getByLabel("Gültig ab (Stichtag)").fill(cutoff);
  await form.getByLabel("Name").fill(NAME);
  await form.getByRole("button", { name: "Entwurf anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${NAME}“ angelegt` })).toBeVisible();
  const card = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME}$`) });
  await card.getByRole("link", { name: "Im Entwurf arbeiten" }).click();
  await expect(page).toHaveURL(/\/planung\/stundenplan\?quelle=[\w-]+$/);
  const versionId = new URL(page.url()).searchParams.get("quelle")!;
  await page.goto(`/planung/stundenplan?gruppe=g-7b&quelle=${versionId}`);
  await page.getByRole("table", { name: "Stundenplan Klasse 7b" }).getByRole("link", { name: /^Deutsch BRA/ }).first().click();
  await expect(page.getByRole("heading", { name: /^Stunde bearbeiten/ })).toBeVisible();
  const weekday = Number(await page.getByLabel("Wochentag").inputValue());
  const period = await page.getByLabel("Stunde", { exact: true }).inputValue();
  await page.getByLabel("Raum").selectOption("105");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();
  const day = plus(cutoff, weekday);

  // Entfall dieser Stunde am ersten Tag ab Stichtag (gültiger Plan)
  const subsUrl = `/planung/vertretungen?datum=${day}&gruppe=g-7b`;
  const lessons = page.getByRole("region", { name: /^Stunden am/ });
  await page.goto(subsUrl);
  const subForm = lessons.getByRole("form", { name: new RegExp(`^${period}\\. Std · Deutsch`) });
  await subForm.getByRole("radio", { name: "Entfall" }).check();
  await subForm.getByRole("button", { name: "Speichern" }).click();
  await expect(subForm.getByRole("status")).toContainText("Gespeichert");

  // Jana: Plan der Woche ab Stichtag vorher (Datumswähler „Plan am“)
  const jana = await as(browser, "jana.brandt");
  const janaPlan = jana.page.getByRole("table", { name: /^Mein Stundenplan, KW/ });
  const planAt = async (ymdDay: string) => {
    await jana.page.goto("/stundenplan");
    const pick = jana.page.getByRole("form", { name: "Plan am Tag" });
    await pick.getByLabel("Plan am").fill(ymdDay);
    await pick.getByRole("button", { name: "Plan zeigen" }).click();
    await expect(jana.page).toHaveURL(new RegExp(`woche=${ymdDay}`));
    await expect(janaPlan).toBeVisible();
    return janaPlan.innerText();
  };
  const janaBefore = await planAt(cutoff);
  const janaWeekBefore = await planAt(plus(cutoff, -7));

  // Prüfung und Freigabe (Schulleitung); solange freigegeben: Hinweis im Vertretungs-Arbeitsplatz (R2)
  await approveVersion(page, browser, versionId);
  await page.goto(subsUrl);
  await expect(page.getByTestId("versionsgrenze")).toContainText(NAME);

  // Vorschau der Veröffentlichung mit Zahlen
  await page.goto("/planung/versionen");
  await card.getByRole("link", { name: "Veröffentlichen …" }).click();
  await expect(page).toHaveURL(/\/planung\/versionen\/veroeffentlichen\?version=/);
  await expect(page.getByRole("heading", { name: /^Veröffentlichen · Version \d+\.0$/, level: 1 })).toBeVisible();
  const pick = page.getByRole("form", { name: "Stichtag wählen" });
  await pick.getByLabel("Gültig ab (Schultag)").fill(cutoff);
  await pick.getByRole("button", { name: "Vorschau aktualisieren" }).click();
  await expect(page.getByTestId("zahl-geändert")).toHaveText("1");
  await expect(page.getByTestId("zahl-neu")).toHaveText("0");
  await expect(page.getByTestId("zahl-entfallen")).toHaveText("0");
  await expect(page.getByTestId("vertretungen")).toContainText("1 zieht um");
  await expect(page.getByTestId("gong")).toContainText("Lehrkraft bekommt sie sofort");
  await axe(page, "Vorschau der Veröffentlichung");
  await page.screenshot({ path: ".data/shots/e2e/planung-veroeffentlichen-vorschau.png", fullPage: true });

  // veröffentlichen
  await page.getByRole("button", { name: `Ab ${deDate(cutoff)} veröffentlichen` }).click();
  await expect(page.getByRole("status")).toContainText("Veröffentlicht", { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Veröffentlichung zurücknehmen" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Veröffentlichte Versionen" })).toContainText(`${deDate(cutoff)} – offen`);
  await page.goto(subsUrl);
  await expect(page.getByTestId("versionsgrenze")).toHaveCount(0);
  // der Entfall ist an der neuen Stunde (gleicher Tag, gleiche Stunde)
  await expect(subForm.getByRole("button", { name: "Aufheben" })).toBeVisible();

  // Jana: Änderungsliste im Gong; Plan ab Stichtag neu, Woche davor unverändert (Plan am Tag X)
  await jana.page.goto("/");
  await jana.page.getByRole("button", { name: /Gong/ }).click();
  const item = jana.page.getByRole("button", { name: /Neuer Stundenplan ab/ });
  await expect(item).toBeVisible();
  await expect(item).toContainText("Raum 106 → 105");
  const janaAfter = await planAt(cutoff);
  expect(janaAfter).not.toBe(janaBefore);
  expect(janaAfter).toContain("105");
  await expect(jana.page.getByTestId("plan-version")).toContainText(/Plan-Version \d+\.0/);
  expect(await planAt(plus(cutoff, -7))).toBe(janaWeekBefore);
  await expect(jana.page.getByTestId("plan-version")).toContainText("1.0");
  // Druck: Plan am Tag X
  await jana.page.goto(`/druck/stundenplan?tag=${cutoff}`);
  await expect(jana.page.getByText(/^Regelplan · Stand .* · Version \d+\.0$/)).toBeVisible();

  // Schülerin: Gong erst am Vortag (Einstellung), kein Entwurf, keine Kommentare
  const lea = await as(browser, "lea.schaefer");
  await lea.page.getByRole("button", { name: /Gong/ }).click();
  await expect(lea.page.getByRole("button", { name: /Neuer Stundenplan ab/ })).toHaveCount(0);
  await lea.close();

  // 360 px, dunkel: Veröffentlichungsseite und Plan der Lehrkraft
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const pErrors = collectErrors(p);
  await p.goto(`/planung/versionen/veroeffentlichen?version=${versionId}`);
  await expect(p.getByRole("heading", { name: "Veröffentlichung zurücknehmen" })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axe(p, "Veröffentlichung 360 px dunkel");
  expect(pErrors).toEqual([]);
  await narrow.close();
  const janaNarrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await jana.page.context().storageState() });
  const jp = await janaNarrow.newPage();
  await jp.goto(`/stundenplan?woche=${cutoff}`);
  await expect(jp.getByTestId("plan-version")).toBeVisible();
  expect(await jp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axe(jp, "Plan am Tag X 360 px dunkel");
  await janaNarrow.close();

  // zurücknehmen → alter Plan, Entfall wieder an der alten Stunde, Jana bekommt die Rücknahme; aufräumen
  await undoAndDiscardVersion(page, versionId);
  expect(await planAt(cutoff)).toBe(janaBefore);
  await jana.page.goto("/");
  await jana.page.getByRole("button", { name: /Gong/ }).click();
  await expect(jana.page.getByRole("button", { name: /Neuer Stundenplan ab .* zurückgenommen/ })).toBeVisible();
  await page.goto(subsUrl);
  await expect(subForm.getByRole("button", { name: "Aufheben" })).toBeVisible();
  await subForm.getByRole("button", { name: "Aufheben" }).click();
  await expect(subForm.getByRole("button", { name: "Aufheben" })).toHaveCount(0);
  expect(jana.errors).toEqual([]);
  await jana.close();
  expect(errors).toEqual([]);
});
