import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { acknowledgeWarnings, collectErrors, deDate, login, undoAndDiscardVersion } from "./helpers";

// SP3-08 (docs/STUNDENPLAN-LEBENSZYKLUS.md §7.2, §9): E2E-Gesamtszenario „Planungszyklus“ für GATE SP3. Die Planung (frank.schulte) beginnt im
// Planungsfahrplan mit der Vorlage „Neues Halbjahr“ (Stichtag und Nummer kommen aus der Vorlage), öffnet die Matrix (Lehraufträge am Stichtag,
// Live-Bilanz, nichts gespeichert), ändert im Entwurf eine Stunde (Raum) und setzt eine andere mit der Setzhilfe neu, quittiert die Warnungen der
// Diagnose (Schritt 7), gibt zur Prüfung, schaltet die Lehrkräfte-Vorschau ein (Lehrkraft sieht nur den eigenen Plan), die Schulleitung
// (petra.lindner) gibt frei; die Schülerin sieht nichts davon. Dann „Ab Stichtag veröffentlichen“: der Entfall der geänderten Stunde zieht mit,
// die Lehrkraft bekommt die Änderungsliste, „Plan am Tag X“ zeigt vor dem Stichtag den alten und danach den neuen Plan, der Zeitstrahl nennt
// beide Versionen (die Vorgängerin archiviert). Danach die Vorlage „Änderung im laufenden Plan“ (Folgeversion), Zurücknehmen der Veröffentlichung
// (alter Stand, Entfall wieder an der alten Stunde) und Aufräumen. Dazu axe hell/dunkel und 360 px auf Fahrplan, Matrix, Prüfung, Vorschau,
// Veröffentlichung und Versionsliste.
// Unabhängig von Wochentag und Uhrzeit: Stichtag aus der Vorlage, der Tag der Vertretung folgt dem Wochentag der geänderten Stunde. Ist das
// 2. Halbjahr der Demo-Schule schon angebrochen (Vorlage nicht mehr angeboten), läuft das Szenario mit „Änderung im laufenden Plan“.
// „zx-gate-sp3“: läuft spät (nach zx-gate-sp2/-vt), räumt aber selbst auf (Version zurückgenommen und verworfen, Vertretung aufgehoben).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function as(browser: Browser, user: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { page, errors, close: () => ctx.close() };
}

const toYmd = (de: string) => de.split(".").reverse().join("-");
const plus = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** Erster Tag ab `start` (einschließlich) mit dem Wochentag `weekday` (0 = Montag, wie im Plan). */
function dayOnOrAfter(start: string, weekday: number): string {
  const wd = (new Date(`${start}T12:00:00Z`).getUTCDay() + 6) % 7;
  return plus(start, (weekday - wd + 7) % 7);
}

test("GATE SP3: Neues Halbjahr → Matrix → Entwurf setzen → quittieren → Vorschau → Freigabe → veröffentlichen → Vertretung zieht um → Folgeversion → zurücknehmen → Plan am Tag X", async ({ page, browser }) => {
  test.setTimeout(480_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // 1) Fahrplan: Vorlage „Neues Halbjahr“ (sonst „Änderung im laufenden Plan“, wenn das Halbjahr schon begonnen hat)
  await page.goto("/planung/fahrplan");
  await expect(page.getByRole("heading", { name: "Planungsfahrplan", level: 1 })).toBeVisible();
  const more = page.getByText("Weitere Planung beginnen (Vorlagen)");
  if ((await more.count()) > 0) await more.click();
  let template = page.locator("[data-vorlage=halbjahr]");
  if ((await template.getByRole("button").count()) === 0) template = page.locator("[data-vorlage=aenderung]");
  await expect(template.getByRole("button")).toHaveCount(1);
  const offer = (await template.textContent())!.match(/Version (\d+\.\d+) ab (\d{2}\.\d{2}\.\d{4})/)!;
  const [, label, fromDe] = offer;
  const from = toYmd(fromDe!);
  // Datum als Muster („01.02.“) für die Gong-Einträge – frühere Specs lassen eigene zurück
  const dm = `${fromDe!.slice(0, 2)}[.]${fromDe!.slice(3, 5)}[.]`;
  await axe(page, "Fahrplan mit Vorlagen");
  await template.getByRole("button").click();
  await expect(page).toHaveURL(/\/planung\/fahrplan\?version=[\w-]+&angelegt=1/);
  const versionId = new URL(page.url()).searchParams.get("version")!;
  await expect(page.getByRole("status")).toContainText(`Entwurf ${label}`);
  await expect(page.locator("[data-schritt]")).toHaveCount(8);
  await expect(page.getByTestId("ampel-pruefen")).toContainText("offen");

  // 2) Matrix aus Schritt „Unterrichtsverteilung“: Lehraufträge am Stichtag, Live-Bilanz; die Änderung wird mit Esc verworfen (nichts gespeichert)
  await page.locator("[data-schritt=verteilung]").getByRole("link", { name: "Matrix" }).click();
  await expect(page).toHaveURL(new RegExp(`ansicht=matrix.*quelle=${versionId}`));
  await page.goto(`/planung/unterricht?ansicht=matrix&jahrgang=7&quelle=${versionId}`);
  await expect(page.getByRole("region", { name: "Matrix Klasse × Fach (Tabelle)" })).toBeVisible();
  const cell = page.getByLabel("Lehrkraft Klasse 7b, Deutsch", { exact: true });
  const owner = await cell.inputValue();
  expect(owner).not.toBe("");
  await cell.fill("BEC");
  await expect(page.getByRole("table", { name: "Deputatsbilanz der betroffenen Lehrkräfte" })).toBeVisible();
  await expect(page.getByText("1 ungespeicherte Änderung.")).toBeVisible();
  await axe(page, "Matrix im Entwurf");
  await cell.press("Escape");
  await expect(cell).toHaveValue(owner);

  // 3) Setzen im Entwurf: Raum einer Deutsch-Stunde der 7b ändern, eine zweite Deutsch-Stunde löschen und mit der Setzhilfe neu setzen
  await page.goto(`/planung/stundenplan?gruppe=g-7b&quelle=${versionId}`);
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();
  const plan = page.getByRole("table", { name: "Stundenplan Klasse 7b" });
  const deutsch = plan.getByRole("link", { name: /^Deutsch BRA/ });
  expect(await deutsch.count()).toBeGreaterThanOrEqual(2);
  await deutsch.first().click();
  await expect(page.getByRole("heading", { name: /^Stunde bearbeiten/ })).toBeVisible();
  const weekday = Number(await page.getByLabel("Wochentag").inputValue());
  const period = await page.getByLabel("Stunde", { exact: true }).inputValue();
  const oldRoom = await page.getByLabel("Raum").inputValue();
  const newRoom = oldRoom === "105" ? "106" : "105";
  await page.getByLabel("Raum").selectOption(newRoom);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();

  await page.goto(`/planung/stundenplan?gruppe=g-7b&quelle=${versionId}`);
  await deutsch.last().click();
  await expect(page.getByRole("heading", { name: /^Stunde bearbeiten/ })).toBeVisible();
  await page.getByRole("button", { name: "Stunde löschen" }).click();
  const openDeutsch = page.locator('[aria-labelledby="open-title"]').getByRole("link", { name: /^Deutsch/ });
  await expect(openDeutsch.first()).toBeVisible();
  await openDeutsch.first().click();
  const place = page.getByRole("button", { name: /^Hier setzen: / });
  await expect(place.first()).toBeVisible();
  await place.last().click();
  await expect(page.getByTestId("entwurf-hinweis")).toBeVisible();
  await expect(openDeutsch).toHaveCount(0);

  // Änderungen zum gültigen Plan
  await page.goto(`/planung/versionen/aenderungen?version=${versionId}`);
  await expect(page.getByRole("list", { name: "Zusammenfassung" })).toContainText(/geändert: [1-9]/);
  await axe(page, "Änderungen");

  // 4) Prüfen (Schritt 7): Warnungen der Diagnose quittieren
  await acknowledgeWarnings(page, versionId, "im Szenario bekannt");
  await axe(page, "Fahrplan, Schritt 7");

  // 5) Zur Prüfung geben, Vorschau für Lehrkräfte einschalten
  const review = `/planung/versionen/pruefung?version=${versionId}`;
  await page.goto(review);
  await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
  await expect(page.getByRole("status")).toContainText("Zur Prüfung gegeben");
  await page.getByRole("button", { name: "Vorschau einschalten" }).click();
  await expect(page.getByRole("status")).toContainText("Lehrkräfte-Vorschau eingeschaltet");

  // Lehrkraft (Jana Brandt, BRA): Vorschau nur des eigenen Plans mit der neuen Stunde; Schülerin: 404
  const jana = await as(browser, "jana.brandt");
  await jana.page.goto(`/stundenplan/vorschau?version=${versionId}`);
  await expect(jana.page.getByTestId("vorschau-hinweis")).toContainText("Entwurf – kann sich noch ändern.");
  const grid = jana.page.getByRole("table", { name: /^Mein Plan ab / });
  await expect(grid).toBeVisible();
  expect(await grid.innerText()).toContain(newRoom);
  expect(await grid.innerText()).not.toMatch(/\b(LIN|KLE|SCU)\b/);
  await axe(jana.page, "Vorschau (Lehrkraft)");
  const lea = await as(browser, "lea.schaefer");
  expect((await lea.page.goto(`/stundenplan/vorschau?version=${versionId}`))?.status()).toBe(404);
  await lea.close();

  // Schulleitung gibt frei
  const sl = await as(browser, "petra.lindner");
  await sl.page.goto(review);
  await axe(sl.page, "Prüfseite (Schulleitung)");
  await sl.page.getByRole("button", { name: "Freigeben" }).click();
  await expect(sl.page.getByRole("status")).toContainText("Freigegeben");
  await expect(sl.page.getByTestId("freigabe")).toContainText("Petra Lindner");
  await sl.close();

  // 6) Eine Vertretung (Entfall) in der geänderten Stunde am ersten passenden Tag ab Stichtag (gültiger Plan), Plan der Lehrkraft vorher
  const day = dayOnOrAfter(from, weekday);
  const subsUrl = `/planung/vertretungen?datum=${day}&gruppe=g-7b`;
  await page.goto(subsUrl);
  await expect(page.getByTestId("versionsgrenze")).toContainText(label!); // R2: ab dem Stichtag gilt die freigegebene Version
  const subForm = page.getByRole("region", { name: /^Stunden am/ }).getByRole("form", { name: new RegExp(`^${period}\\. Std · Deutsch`) });
  await subForm.getByRole("radio", { name: "Entfall" }).check();
  await subForm.getByRole("button", { name: "Speichern" }).click();
  await expect(subForm.getByRole("status")).toContainText("Gespeichert");

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
  const janaBefore = await planAt(from);
  const janaWeekBefore = await planAt(plus(from, -7));

  // 7) Veröffentlichen ab Stichtag: Vorschau mit Zahlen, Vertretung zieht um
  await page.goto(`/planung/versionen/veroeffentlichen?version=${versionId}&ab=${from}`);
  await expect(page.getByTestId("zahl-geändert")).not.toHaveText("0");
  await expect(page.getByTestId("vertretungen")).toContainText(/[1-9]\d* zieht um/);
  await expect(page.getByTestId("gong")).toContainText("Lehrkraft bekommt sie sofort");
  await axe(page, "Vorschau der Veröffentlichung");
  await page.screenshot({ path: ".data/shots/e2e/gate-sp3-veroeffentlichen.png", fullPage: true });
  await page.getByRole("button", { name: `Ab ${deDate(from)} veröffentlichen` }).click();
  await expect(page.getByRole("status")).toContainText("Veröffentlicht", { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Veröffentlichung zurücknehmen" })).toBeVisible();
  await page.goto(subsUrl);
  await expect(page.getByTestId("versionsgrenze")).toHaveCount(0);
  await expect(subForm.getByRole("button", { name: "Aufheben" })).toBeVisible(); // der Entfall liegt an der neuen Stunde

  // Zeitstrahl: Vorgängerin bis zum Vortag, neue Version ab Stichtag offen
  await page.goto("/planung/versionen");
  const timeline = page.getByRole("list", { name: "Veröffentlichte Versionen" });
  await expect(timeline).toContainText(`${deDate(from)} – offen`);
  await expect(timeline).toContainText(`– ${deDate(plus(from, -1))}`);
  await expect(timeline.getByText("archiviert").first()).toBeVisible();
  await axe(page, "Versionsliste mit Zeitstrahl");
  await page.screenshot({ path: ".data/shots/e2e/gate-sp3-versionen.png", fullPage: true });

  // Lehrkraft: Änderungsliste im Gong; Plan am Tag X: ab Stichtag neu, davor unverändert
  await jana.page.goto("/");
  await jana.page.getByRole("button", { name: /Gong/ }).click();
  await expect(jana.page.getByRole("button", { name: new RegExp(`Neuer Stundenplan ab [^:]*${dm}: `) }).first()).toBeVisible();
  const janaAfter = await planAt(from);
  expect(janaAfter).not.toBe(janaBefore);
  expect(janaAfter).toContain(newRoom);
  await expect(jana.page.getByTestId("plan-version")).toContainText(`Plan-Version ${label}`);
  expect(await planAt(plus(from, -7))).toBe(janaWeekBefore);
  await expect(jana.page.getByTestId("plan-version")).toContainText("Plan-Version 1.0");
  await jana.page.goto(`/druck/stundenplan?tag=${from}`);
  await expect(jana.page.getByText(new RegExp(`^Regelplan · Stand .* · Version ${label!.replace(".", "\\.")}$`))).toBeVisible();

  // 8) Folgeversion: Vorlage „Änderung im laufenden Plan“ (der Fahrplan zeigt die Vorlagen nach dem Veröffentlichen wieder)
  await page.goto("/planung/fahrplan");
  const more2 = page.getByText("Weitere Planung beginnen (Vorlagen)");
  if ((await more2.count()) > 0) await more2.click();
  const followUp = page.locator("[data-vorlage=aenderung]");
  let followId = "";
  {
    await expect(followUp.getByRole("button")).toHaveCount(1);
    await expect(followUp).toContainText(/Version \d+\.[1-9]/);
    await followUp.getByRole("button", { name: "Folgeversion anlegen" }).click();
    await expect(page).toHaveURL(/\/planung\/fahrplan\?version=[\w-]+&angelegt=1/);
    followId = new URL(page.url()).searchParams.get("version")!;
    await expect(page.locator("[data-schritt]")).toHaveCount(8);
    await expect(page.getByText("Bei einer Änderung im laufenden Plan meist unverändert – Einzelheiten zeigen")).toHaveCount(4);
    await axe(page, "Fahrplan der Folgeversion");
  }

  // 9) schmal und dunkel: Fahrplan, Prüfseite, Veröffentlichung und Versionsliste ohne axe-Befund und ohne seitliches Scrollen
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const pErrors = collectErrors(p);
  for (const url of [
    `/planung/fahrplan?version=${versionId}`,
    `/planung/unterricht?ansicht=matrix&jahrgang=7&quelle=${versionId}`,
    review,
    `/planung/versionen/veroeffentlichen?version=${versionId}`,
    "/planung/versionen",
  ]) {
    await p.goto(url);
    await expect(p.getByRole("main")).toBeVisible();
    await axe(p, `${url} (360 px, dunkel)`);
    if (!url.includes("ansicht=matrix")) expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  }
  await p.screenshot({ path: ".data/shots/e2e/gate-sp3-versionen-360-dunkel.png", fullPage: true });
  expect(pErrors).toEqual([]);
  await narrow.close();

  // 10) Folgeversion verwerfen, Veröffentlichung zurücknehmen → alter Plan, Entfall wieder an der alten Stunde; Vertretung aufheben
  await discardDraft(page, followId);
  await undoAndDiscardVersion(page, versionId);
  expect(await planAt(from)).toBe(janaBefore);
  await jana.page.goto("/");
  await jana.page.getByRole("button", { name: /Gong/ }).click();
  await expect(jana.page.getByRole("button", { name: new RegExp(`Neuer Stundenplan ab [^:]*${dm} zurückgenommen`) }).first()).toBeVisible();
  await page.goto(subsUrl);
  await expect(subForm.getByRole("button", { name: "Aufheben" })).toBeVisible();
  await subForm.getByRole("button", { name: "Aufheben" }).click();
  await expect(subForm.getByRole("button", { name: "Aufheben" })).toHaveCount(0);
  await page.goto("/planung/versionen");
  await expect(page.getByRole("list", { name: "Veröffentlichte Versionen" })).not.toContainText(`${deDate(from)} – offen`);

  expect(jana.errors).toEqual([]);
  await jana.close();
  expect(errors).toEqual([]);
});

/** Offenen Entwurf (Karte der Versionsliste) verwerfen. */
async function discardDraft(page: Page, versionId: string) {
  await page.goto("/planung/versionen");
  const card = page.locator("article").filter({ has: page.locator(`a[href*="version=${versionId}"]`) }).first();
  if ((await card.getByRole("button", { name: "Verwerfen" }).count()) > 0) {
    page.once("dialog", (d) => void d.accept());
    await card.getByRole("button", { name: "Verwerfen" }).click();
    await expect(page.getByRole("status")).toContainText("verworfen");
  }
}
