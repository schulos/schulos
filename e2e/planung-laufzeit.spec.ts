import AxeBuilder from "./axe";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { approveVersion, collectErrors, deDate, login, publishVersionAt, undoAndDiscardVersion } from "./helpers";

// SP3-05: Änderungen während der Laufzeit. Die Planung (frank.schulte) ändert eine laufende Stunde der 9a im gültigen Plan → Sofort-Korrektur
// als Split ab dem nächsten Schultag (heute bleibt die Stunde, wie sie war; Begründung im Protokoll) → die Lehrkraft der Stunde bekommt den
// Gong → zurückdrehen (die neue Stunde beginnt erst morgen: direkt geändert) → ab 10 direkt geänderten Stunden rät die Pflege zur Folgeversion
// → Vorlage „Änderung im laufenden Plan“ (Folgeversion) → im Entwurf ändern → Änderungen → Freigabe (Schulleitung) → veröffentlichen →
// zurücknehmen und verwerfen. Pflege und Versionsliste mit axe, schmal (360 px) und dunkel. Kein Bezug auf Wochentag oder Uhrzeit: der
// Stichtag kommt aus dem Hinweis der Seite.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const toYmd = (de: string) => de.split(".").reverse().join("-");
const minusDay = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

async function as(browser: Browser, user: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { page, errors, close: () => ctx.close() };
}

test("SP3-05: Sofort-Korrektur → Split ab dem nächsten Schultag → Gong → Hinweis ab 10 → Folgeversion veröffentlichen", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  const base = "/planung/stundenplan?gruppe=g-9a";
  await page.goto(base);
  const hint = page.getByTestId("korrektur-hinweis");
  await expect(hint).toContainText("Sofort-Korrektur ab");
  const fromDe = /Sofort-Korrektur ab (\d\d\.\d\d\.\d{4})/.exec((await hint.textContent())!)![1]!;
  const from = toYmd(fromDe);

  // eine laufende Einzelstunde der 9a (ohne Kopplung) mit Lehrkraft und Raum öffnen – nicht die eigene (die handelnde Person bekommt keinen Gong)
  const table = page.getByRole("table", { name: "Stundenplan Klasse 9a" });
  const first = table.locator('a[href*="stunde="]').filter({ hasText: /[A-ZÄÖÜ]{3} · \S+/ }).filter({ hasNotText: "SLT" }).first();
  const oldId = new URL((await first.getAttribute("href"))!, "http://x").searchParams.get("stunde")!;
  await first.click();
  await expect(page.getByRole("heading", { name: /^Stunde bearbeiten/ })).toBeVisible();
  await expect(page.getByTestId("sofortkorrektur-hinweis")).toContainText(`ab ${fromDe}`);
  const teacherId = await page.getByLabel("Lehrkraft").inputValue();
  const room = await page.getByLabel("Raum").inputValue();
  const weekday = Number(await page.getByLabel("Wochentag").inputValue());
  const period = Number(await page.getByLabel("Stunde", { exact: true }).inputValue());
  expect(teacherId).toMatch(/^u-/);
  expect(room).not.toBe("");
  await page.getByLabel("Raum").selectOption("");
  await page.getByLabel("Begründung (optional)").fill("Raumtausch Brandschutz");
  await page.getByRole("button", { name: "Speichern" }).click();

  // Split: die Seite zeigt den Plan ab dem Stichtag und das Ergebnis
  await expect(page).toHaveURL(new RegExp(`stand=${from}.*korrektur=`));
  await expect(page.getByTestId("korrektur-ergebnis")).toContainText(`Sofort-Korrektur ab ${fromDe}: 1 Stunde (1 ab dem Stichtag neu)`);
  await page.screenshot({ path: ".data/shots/e2e/planung-sofortkorrektur.png", fullPage: true });
  const cell = page.getByRole("table", { name: "Stundenplan Klasse 9a" }).locator("tbody tr").nth(period - 1).locator("td").nth(weekday + 1);
  const succ = cell.locator('a[href*="stunde="]').first();
  const succId = new URL((await succ.getAttribute("href"))!, "http://x").searchParams.get("stunde")!;
  expect(succId).not.toBe(oldId);
  // heute gilt die bisherige Stunde unverändert bis zum Vortag des Stichtags
  await page.goto(`${base}&stunde=${oldId}`);
  await expect(page.getByLabel("Raum")).toHaveValue(room);
  await expect(page.getByLabel("Gültig bis")).toHaveValue(minusDay(from));

  // die Lehrkraft der Stunde bekommt den Gong (mit der Änderung, ohne Begründung)
  const teacher = await as(browser, teacherId.replace(/^u-/, ""));
  await teacher.page.getByRole("button", { name: /Gong/ }).click();
  const item = teacher.page.getByRole("button", { name: /Stundenplan ab .* geändert: 1 Änderung für dich/ }).first();
  await expect(item).toBeVisible();
  await expect(item).toContainText(`Raum ${room} → –`);
  await expect(item).not.toContainText("Brandschutz");

  // zurückdrehen: die neue Stunde beginnt erst am Stichtag – ohne Vergangenheitsbezug direkt geändert; dann bis zum Hinweis weiter umschalten
  let correctionUrl = page.url();
  const editSucc = async (value: string) => {
    await page.goto(`${base}&stand=${from}&stunde=${succId}`);
    await expect(page.getByRole("heading", { name: /^Stunde bearbeiten/ })).toBeVisible();
    await expect(page.getByTestId("sofortkorrektur-hinweis")).toHaveCount(0);
    await page.getByLabel("Raum").selectOption(value);
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByTestId("korrektur-ergebnis")).toContainText("1 direkt geändert");
    correctionUrl = page.url();
  };
  await editSucc(room);
  for (let i = 0; i < 10 && (await page.getByTestId("folgeversion-hinweis").count()) === 0; i++) await editSucc(i % 2 === 0 ? "" : room);
  await expect(page.getByTestId("folgeversion-hinweis")).toContainText("besser als Folgeversion");
  await page.goto(`${base}&stand=${from}&stunde=${succId}`);
  if ((await page.getByLabel("Raum").inputValue()) !== room) await editSucc(room);
  await page.goto(correctionUrl);

  // Folgeversion aus der Vorlage „Änderung im laufenden Plan“
  await page.getByTestId("folgeversion-hinweis").getByRole("link", { name: /Änderung im laufenden Plan/ }).click();
  const template = page.getByRole("article", { name: "Änderung im laufenden Plan" });
  await expect(template.getByTestId("vorlage-aenderung")).toHaveText(new RegExp(`^Version \\d+\\.\\d+ ab ${fromDe.replaceAll(".", "\\.")}$`));
  const create = template.getByRole("button", { name: "Folgeversion anlegen" });
  await create.click();
  const status = page.getByRole("status").filter({ hasText: "angelegt" });
  await expect(status).toContainText(`Änderung ab ${fromDe}`);
  await status.getByRole("link", { name: "Im Entwurf arbeiten" }).click();
  await expect(page).toHaveURL(/\/planung\/stundenplan\?quelle=[\w-]+$/);
  const versionId = new URL(page.url()).searchParams.get("quelle")!;
  await page.goto(`${base}&quelle=${versionId}`);
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();
  const draftCell = page.getByRole("table", { name: "Stundenplan Klasse 9a" }).locator("tbody tr").nth(period - 1).locator("td").nth(weekday + 1);
  await draftCell.locator('a[href*="stunde="]').first().click();
  await expect(page.getByTestId("sofortkorrektur-hinweis")).toHaveCount(0);
  await page.getByLabel("Raum").selectOption("");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();
  await page.goto(`/planung/versionen/aenderungen?version=${versionId}`);
  await expect(page.getByRole("list", { name: "Zusammenfassung" })).toContainText("geändert: 1");

  // Prüfung → Freigabe (Schulleitung) → veröffentlichen ab dem Stichtag; die Lehrkraft bekommt die Änderungsliste
  await approveVersion(page, browser, versionId);
  await publishVersionAt(page, versionId, from);
  await teacher.page.goto("/");
  await teacher.page.getByRole("button", { name: /Gong/ }).click();
  await expect(teacher.page.getByRole("button", { name: /Neuer Stundenplan ab/ }).first()).toContainText(`Raum ${room} → –`);

  // 360 px, dunkel: Pflege mit Hinweisen und Versionsliste mit den Vorlagen
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const pErrors = collectErrors(p);
  await p.goto(correctionUrl);
  await expect(p.getByTestId("korrektur-ergebnis")).toBeVisible();
  await axe(p, "Pflege mit Sofort-Korrektur 360 px dunkel");
  await p.goto("/planung/versionen");
  await expect(p.getByRole("heading", { name: "Vorlagen" })).toBeVisible();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axe(p, "Vorlagen 360 px dunkel");
  expect(pErrors).toEqual([]);
  await narrow.close();

  // aufräumen: zurücknehmen und verwerfen
  await undoAndDiscardVersion(page, versionId);
  expect(teacher.errors).toEqual([]);
  await teacher.close();
  expect(errors).toEqual([]);
  expect(deDate(from)).toBe(fromDe);
});
