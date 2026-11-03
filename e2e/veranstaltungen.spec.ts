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
