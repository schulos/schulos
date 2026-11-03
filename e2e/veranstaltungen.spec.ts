import { expect, test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { collectErrors, login } from "./helpers";

// VA-01…VA-03 (Runde 13): Veranstaltungsanmeldung an die Hausmeisterei. Eine Lehrkraft meldet am Handy (360 px, dunkel, axe) einen
// Elternabend an, die Hausmeisterei fragt nach, die Lehrkraft antwortet, die Hausmeisterei bestätigt mit Schulkalender-Eintrag.
// Abends liegt kein Unterricht – es entsteht keine Raumsperre. Schülerin und fremde Lehrkraft bekommen 404. Termin weit in der
// Zukunft (eigener Titel), damit „Heute im Haus“ und die Wochenvorschau anderer Tests unberührt bleiben.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const MOBILE = { viewport: { width: 360, height: 800 }, colorScheme: "dark" as const };

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function noOverflow(page: Page) {
  const r = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    wide: [...document.querySelectorAll("main *")]
      .filter((e) => e.getBoundingClientRect().right > 361 && !e.closest(".overflow-x-auto, .overflow-auto, nav"))
      .slice(-5)
      .map((e) => `${e.tagName}.${String(e.className).slice(0, 60)} → ${Math.round(e.getBoundingClientRect().right)}: ${(e.textContent ?? "").slice(0, 50)}`),
  }));
  expect(r.width, r.wide.join(" | ")).toBeLessThanOrEqual(360);
}

function isoInDays(days: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date(Date.now() + days * 86_400_000));
}

async function mobilePage(browser: Browser, user: string) {
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { ctx, page, errors };
}

test("VA-01…03: Lehrkraft meldet am Handy an, Hausmeisterei fragt nach und bestätigt mit Schulkalender; andere 404", async ({ browser }) => {
  test.setTimeout(180_000);
  const title = `Elternabend E2E ${Date.now() % 100_000}`;
  const day = isoInDays(80);

  // Lehrkraft: Einstieg über „Gebäude & Technik“, Formular am Handy
  const jana = await mobilePage(browser, "jana.brandt");
  await jana.page.goto("/gebaeude");
  await jana.page.getByRole("link", { name: /^Veranstaltung anmelden/ }).click();
  await expect(jana.page).toHaveURL(/\/gebaeude\/veranstaltungen\/neu$/);
  await noOverflow(jana.page);
  await axeClean(jana.page);
  const form = jana.page.getByRole("form", { name: "Veranstaltung anmelden" });
  await form.getByLabel("Was findet statt?").fill(title);
  await form.getByLabel("Beginn", { exact: true }).fill(`${day}T19:00`);
  await form.getByLabel("Ende", { exact: true }).fill(`${day}T21:00`);
  await form.getByLabel("Aufbau ab").fill(`${day}T17:30`);
  await form.getByLabel("Räume").selectOption(["106"]);
  await form.getByLabel("Erwartete Personen").fill("80");
  await form.getByLabel("Bestuhlung").selectOption({ label: "Stuhlreihen" });
  await form.getByLabel("Technik (Beamer, Ton, Mikrofon)").check();
  await form.getByLabel("Einzelheiten zum Bedarf").fill("Beamer und ein Mikrofon");
  await form.getByRole("button", { name: "Anmelden" }).click();
  await expect(jana.page).toHaveURL(/\/gebaeude\/veranstaltungen\/[^/]+\?neu=1$/);
  await expect(jana.page.getByRole("status").filter({ hasText: "Angemeldet." })).toBeVisible();
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("Angemeldet");
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("Stuhlreihen");
  const url = new URL(jana.page.url());
  const href = url.pathname;
  await noOverflow(jana.page);
  await axeClean(jana.page);

  // Hausmeisterei: offene Anmeldung in der Übersicht, Rückfrage
  const klaus = await mobilePage(browser, "klaus.berger");
  await klaus.page.goto("/gebaeude/veranstaltungen");
  await expect(klaus.page.getByRole("navigation", { name: "Gebäude & Technik" }).getByRole("link", { name: "Veranstaltungen" })).toHaveAttribute("aria-current", "page");
  await expect(klaus.page.getByRole("list", { name: "Wochenvorschau" })).toBeVisible();
  await noOverflow(klaus.page);
  await axeClean(klaus.page);
  await klaus.page.getByRole("list", { name: "Offene Anmeldungen" }).getByRole("link").filter({ hasText: title }).click();
  await expect(klaus.page).toHaveURL(new RegExp(`${href}$`));
  await expect(klaus.page.getByRole("article", { name: "Angaben" })).toContainText("Jana Brandt");
  await noOverflow(klaus.page);
  await axeClean(klaus.page);
  const ask = klaus.page.getByRole("form", { name: "Rückfrage" });
  await ask.getByLabel("Rückfrage").fill("Reicht der Beamer der Aula?");
  await ask.getByRole("button", { name: "Rückfrage senden" }).click();
  await expect(klaus.page.getByRole("list", { name: "Verlauf" })).toContainText("Reicht der Beamer der Aula?");

  // Lehrkraft antwortet
  await jana.page.goto(href);
  const answer = jana.page.getByRole("form", { name: "Antworten" });
  await answer.getByLabel("Antwort").fill("Ja, plus ein Mikrofon");
  await answer.getByRole("button", { name: "Antworten" }).click();
  await expect(jana.page.getByRole("list", { name: "Verlauf" })).toContainText("Ja, plus ein Mikrofon");

  // Hausmeisterei bestätigt mit Schulkalender – abends kein Unterricht, also keine Raumsperre
  await klaus.page.goto(href);
  const confirm = klaus.page.getByRole("form", { name: "Bestätigen" });
  await expect(confirm.getByText("zurzeit kein Unterricht betroffen")).toBeVisible();
  await confirm.getByLabel("Im Schulkalender eintragen").check();
  await confirm.getByRole("button", { name: "Bestätigen" }).click();
  await expect(klaus.page.getByRole("article", { name: "Angaben" })).toContainText("Bestätigt");
  await expect(klaus.page.getByRole("article", { name: "Angaben" })).toContainText("im Schulkalender");
  await expect(klaus.page.getByRole("article", { name: "Raumsperren" })).toHaveCount(0);

  // Lehrkraft sieht „Bestätigt“ unter „Meine Veranstaltungen“
  await jana.page.goto("/gebaeude/veranstaltungen");
  await expect(jana.page.getByRole("heading", { name: "Meine Veranstaltungen", level: 1 })).toBeVisible();
  await expect(jana.page.getByRole("list", { name: "Meine angemeldeten Veranstaltungen" }).getByRole("link").filter({ hasText: title })).toContainText("Bestätigt");
  await noOverflow(jana.page);
  await axeClean(jana.page);

  // Fremde Lehrkraft und Schülerin: 404
  const other = await mobilePage(browser, "frank.schulte");
  expect((await other.page.goto(href))?.status()).toBe(404);
  const lea = await mobilePage(browser, "lea.schaefer");
  expect((await lea.page.goto("/gebaeude/veranstaltungen"))?.status()).toBe(404);
  expect((await lea.page.goto("/gebaeude/veranstaltungen/neu"))?.status()).toBe(404);

  // Aufräumen: absagen (Kalendereintrag fällt weg)
  await klaus.page.goto(href);
  await klaus.page.getByRole("form", { name: "Absagen" }).getByRole("button", { name: "Veranstaltung absagen" }).click();
  await expect(klaus.page.getByRole("article", { name: "Angaben" })).toContainText("Abgesagt");

  expect(jana.errors).toEqual([]);
  expect(klaus.errors).toEqual([]);
  for (const c of [jana.ctx, klaus.ctx, other.ctx, lea.ctx]) await c.close();
});

// VA-05…07 (Runde 14): Serie am Handy anlegen (wöchentlich, 3 Termine), Hausmeisterei bestätigt die ganze Serie in einem Schritt,
// Lehrkraft verlegt „diesen und alle folgenden“ (wesentlich → neu bestätigen), ändert am ersten Termin nur die Personenzahl
// (Bestätigung bleibt), fremde Lehrkraft 404 auf der Bearbeiten-Seite, Absage der ganzen Serie. Termine weit in der Zukunft.
test("VA-05…07: Serie anlegen, ganz bestätigen, „folgende“ verlegen, unwesentlich ändern, Serie absagen", async ({ browser }) => {
  test.setTimeout(240_000);
  const title = `Chorprobe E2E ${Date.now() % 100_000}`;
  const day = isoInDays(90);

  const jana = await mobilePage(browser, "jana.brandt");
  await jana.page.goto("/gebaeude/veranstaltungen/neu");
  const form = jana.page.getByRole("form", { name: "Veranstaltung anmelden" });
  await form.getByLabel("Was findet statt?").fill(title);
  await form.getByLabel("Beginn", { exact: true }).fill(`${day}T19:00`);
  await form.getByLabel("Ende", { exact: true }).fill(`${day}T21:00`);
  await form.getByLabel("Räume").selectOption(["MU1"]);
  await form.getByLabel("Erwartete Personen").fill("40");
  await form.getByLabel("Wiederholen", { exact: true }).selectOption({ label: "wöchentlich" });
  await form.getByLabel("Anzahl der Termine").fill("3");
  await noOverflow(jana.page);
  await axeClean(jana.page);
  await form.getByRole("button", { name: "Anmelden" }).click();
  await expect(jana.page).toHaveURL(/\/gebaeude\/veranstaltungen\/[^/]+\?neu=1$/);
  await expect(jana.page.getByRole("status").filter({ hasText: "Serie wöchentlich, 3 Termine" })).toBeVisible();
  const series = jana.page.getByRole("list", { name: "Termine der Serie" });
  await expect(series.getByRole("listitem")).toHaveCount(3);
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("Termin 1 von 3");
  const href = new URL(jana.page.url()).pathname;
  await noOverflow(jana.page);
  await axeClean(jana.page);

  // Hausmeisterei: eine Zeile für die Serie, Bestätigen „alle offenen Termine der Serie“
  const klaus = await mobilePage(browser, "klaus.berger");
  await klaus.page.goto("/gebaeude/veranstaltungen");
  const row = klaus.page.getByRole("list", { name: "Offene Anmeldungen" }).getByRole("link").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Serie · 2 weitere Termine");
  await row.click();
  await expect(klaus.page).toHaveURL(new RegExp(`${href}$`));
  const confirm = klaus.page.getByRole("form", { name: "Bestätigen" });
  await expect(confirm.getByLabel("Gilt für")).toHaveValue("serie");
  await noOverflow(klaus.page);
  await axeClean(klaus.page);
  await confirm.getByRole("button", { name: "Bestätigen" }).click();
  await expect(klaus.page.getByRole("article", { name: "Angaben" })).toContainText("Bestätigt");
  await expect(klaus.page.getByRole("list", { name: "Termine der Serie" }).getByText("Bestätigt")).toHaveCount(3);

  // Lehrkraft: zweiter Termin → Bearbeiten, später Ende für „diesen und alle folgenden“
  await jana.page.goto(href);
  await jana.page.getByRole("list", { name: "Termine der Serie" }).getByRole("link").first().click();
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("Termin 2 von 3");
  await jana.page.getByRole("link", { name: "Bearbeiten" }).click();
  await expect(jana.page).toHaveURL(/\/bearbeiten$/);
  const edit = jana.page.getByRole("form", { name: "Veranstaltung bearbeiten" });
  const end2 = await edit.getByLabel("Ende", { exact: true }).inputValue();
  expect(end2).toMatch(/T21:00$/);
  expect(end2 > `${day}T21:00`).toBe(true);
  await noOverflow(jana.page);
  await axeClean(jana.page);
  await edit.getByLabel("Ende", { exact: true }).fill(end2.replace("T21:00", "T21:30"));
  await edit.getByLabel("Änderung gilt für").selectOption("folgende");
  await edit.getByRole("button", { name: "Speichern" }).click();
  await expect(jana.page).toHaveURL(/geaendert=bestaetigen&termine=2$/);
  await expect(jana.page.getByRole("status").filter({ hasText: "die Hausmeisterei bestätigt neu" })).toContainText("(2 Termine geändert)");
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("Angemeldet");
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("21:30");
  await expect(jana.page.getByRole("list", { name: "Verlauf" })).toContainText("Zeit geändert – neu zu bestätigen");
  const janaSeries = jana.page.getByRole("list", { name: "Termine der Serie" });
  await expect(janaSeries.getByRole("listitem").first()).toContainText("Bestätigt");
  await expect(janaSeries.getByText("Angemeldet")).toHaveCount(2);

  // erster Termin: nur die Personenzahl → Bestätigung bleibt
  await jana.page.goto(`${href}/bearbeiten`);
  const edit1 = jana.page.getByRole("form", { name: "Veranstaltung bearbeiten" });
  await edit1.getByLabel("Erwartete Personen").fill("55");
  await edit1.getByRole("button", { name: "Speichern" }).click();
  await expect(jana.page.getByRole("status").filter({ hasText: "Gespeichert." })).toContainText("Die Bestätigung bleibt.");
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("Bestätigt");
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("55");

  // fremde Lehrkraft: 404 auf der Bearbeiten-Seite; Hausmeisterei hat dort keinen Zugang (nur die anmeldende Person)
  const other = await mobilePage(browser, "frank.schulte");
  expect((await other.page.goto(`${href}/bearbeiten`))?.status()).toBe(404);
  expect((await klaus.page.goto(`${href}/bearbeiten`))?.status()).toBe(404);

  // Absage „dieser und alle folgenden“ ab dem ersten Termin = ganze Serie
  await jana.page.goto(href);
  const cancel = jana.page.getByRole("form", { name: "Absagen" });
  await cancel.getByLabel("Gilt für").selectOption("folgende");
  await cancel.getByRole("button", { name: "Veranstaltung absagen" }).click();
  await expect(jana.page.getByRole("article", { name: "Angaben" })).toContainText("Abgesagt");
  await expect(jana.page.getByRole("list", { name: "Termine der Serie" }).getByText("Abgesagt")).toHaveCount(3);

  expect(jana.errors).toEqual([]);
  expect(klaus.errors.filter((e) => !/404/.test(e))).toEqual([]);
  for (const c of [jana.ctx, klaus.ctx, other.ctx]) await c.close();
});

// VA-07 Plananzeige (VA-04): Bestätigung über Unterrichtsstunden am zweiten Tag des Vertretungsplans sperrt Raum 106 – der Plan zeigt
// „Raum 106 gesperrt (Veranstaltung), …“ ohne Titel (360 px, dunkel, axe); Absage räumt die Sperre wieder weg.
test("VA-07: Raumsperre einer Veranstaltung erscheint im Vertretungsplan ohne Titel", async ({ browser }) => {
  test.setTimeout(180_000);
  const title = `Projekttag E2E ${Date.now() % 100_000}`;
  const jana = await mobilePage(browser, "jana.brandt");
  await jana.page.goto("/stundenplan/vertretungen");
  const days = await jana.page.locator('section[aria-labelledby^="tag-"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-labelledby")!.slice(4)));
  const day = days.at(-1)!;
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await jana.page.goto("/gebaeude/veranstaltungen/neu");
  const form = jana.page.getByRole("form", { name: "Veranstaltung anmelden" });
  await form.getByLabel("Was findet statt?").fill(title);
  await form.getByLabel("Beginn", { exact: true }).fill(`${day}T07:30`);
  await form.getByLabel("Ende", { exact: true }).fill(`${day}T13:00`);
  await form.getByLabel("Räume").selectOption(["106"]);
  await form.getByLabel("Erwartete Personen").fill("30");
  await form.getByRole("button", { name: "Anmelden" }).click();
  await expect(jana.page).toHaveURL(/\?neu=1$/);
  const href = new URL(jana.page.url()).pathname;

  const klaus = await mobilePage(browser, "klaus.berger");
  await klaus.page.goto(href);
  await klaus.page.getByRole("form", { name: "Bestätigen" }).getByRole("button", { name: "Bestätigen" }).click();
  await expect(klaus.page.getByRole("article", { name: "Raumsperren" })).toBeVisible();

  await jana.page.goto("/stundenplan/vertretungen");
  const notes = jana.page.locator(`section[aria-labelledby="tag-${day}"]`).getByRole("list", { name: "Tagesmitteilungen" });
  await expect(notes).toContainText(/Raum 106 gesperrt \(Veranstaltung\), \d+\./);
  await expect(notes).not.toContainText(title);
  await noOverflow(jana.page);
  await axeClean(jana.page);

  // Aufräumen: Absage räumt die Sperre weg
  await klaus.page.goto(href);
  await klaus.page.getByRole("form", { name: "Absagen" }).getByRole("button", { name: "Veranstaltung absagen" }).click();
  await expect(klaus.page.getByRole("article", { name: "Angaben" })).toContainText("Abgesagt");
  await jana.page.goto("/stundenplan/vertretungen");
  await expect(jana.page.locator(`section[aria-labelledby="tag-${day}"]`).getByText(/Raum 106 gesperrt \(Veranstaltung\)/)).toHaveCount(0);

  expect(jana.errors).toEqual([]);
  expect(klaus.errors).toEqual([]);
  for (const c of [jana.ctx, klaus.ctx]) await c.close();
});
