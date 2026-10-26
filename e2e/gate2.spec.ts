import { expect, test, type Browser } from "@playwright/test";
import { collectErrors, login, publishIfDraft } from "./helpers";

async function as(browser: Browser, username: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, username);
  return { page, errors, close: () => ctx.close() };
}

test("Gate 2 – Vertretung: Sekretariat trägt ein, Schülerin sieht sie in der Tagesleiste und bekommt einen Gong", async ({ browser }) => {
  const lea = await as(browser, "lea.schaefer");
  const strip = lea.page.getByRole("region", { name: "Tagesleiste" });
  const day = await strip.getAttribute("data-day");
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // eine Stunde ohne bestehende Änderung (die Demo hat schon eine Vertretung am nächsten Schultag)
  const plain = strip.locator('article[data-tone="normal"]').last();
  const period = await plain.getAttribute("data-period");

  const sek = await as(browser, "frank.schulte");
  await sek.page.goto(`/planung/vertretungen?datum=${day}&gruppe=g-7b`);
  const form = sek.page.getByRole("form", { name: new RegExp(`^${period}\\. Std · `) });
  const free = await form.locator('optgroup[label="Frei"] option').first().getAttribute("value");
  await form.getByLabel("Vertretung durch").selectOption(free!);
  await form.getByLabel("Hinweis").fill("Gate 2: Buch mitbringen");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  // Q5-11: Demo-Schule mit Freigabe – ein neuer Tag ist erst ein Entwurf
  await publishIfDraft(sek.page);

  await lea.page.reload();
  const card = strip.locator(`article[data-period="${period}"]`);
  await expect(card).toHaveAttribute("data-tone", "sub");
  await expect(card).toContainText("Vertretung");
  await expect(card).toContainText("Gate 2: Buch mitbringen");
  await lea.page.getByRole("button", { name: /Gong/ }).click();
  // Q5-03: eine Nachricht je Tag – die Demo hat am nächsten Schultag schon Änderungen, dann steht die Stunde in der Übersicht
  await expect(lea.page.getByText(new RegExp(`^Vertretung .*, ${period}\\. Std: |(^| · )${period}\\. Std [^·]*: Vertretung`)).first()).toBeVisible();
  await lea.page.screenshot({ path: ".data/shots/e2e/gate2-vertretung.png" });

  expect([...lea.errors, ...sek.errors]).toEqual([]);
  await lea.close();
  await sek.close();
});

test("Gate 2 – Abwesenheit: Mutter meldet krank, Klassenleitung entschuldigt, Klassenbuch zeigt „entschuldigt“", async ({ browser }) => {
  // Klassenleitung trägt am letzten Schultag in einer eigenen 7b-Stunde ein: Lea fehlt
  const jana = await as(browser, "jana.brandt");
  await jana.page.goto("/klassenbuch");
  // nur Stunden des angezeigten Tages: nachmittags stehen weiter oben auch heutige offene Stunden – und für heute beurlaubt der
  // Q5-16-Test (abwesenheiten.spec.ts) Lea; dann stünde dort „beurlaubt“ statt „entschuldigt“. Der Demo-Plan kommt aus dem Solver –
  // an welchem Vortag Jana Brandt die 7b hat, steht nicht fest: bis zu fünf Schultage zurückgehen
  let day = "";
  let lesson = jana.page.locator("a[href^='/klassenbuch/eintrag']").filter({ hasText: "Klasse 7b" }).first();
  for (let back = 0; back < 5; back++) {
    const before = jana.page.url();
    await jana.page.getByRole("link", { name: "Vorheriger Schultag" }).click();
    await expect(jana.page).not.toHaveURL(before);
    day = new URL(jana.page.url()).searchParams.get("datum")!;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    lesson = jana.page.locator(`a[href^="/klassenbuch/eintrag"][href*="datum=${day}"]`).filter({ hasText: "Klasse 7b" }).first();
    if ((await lesson.count()) > 0) break;
  }
  await expect(lesson).toBeVisible();
  const href = (await lesson.getAttribute("href"))!;
  const date = new URL(href, "http://x").searchParams.get("datum")!;
  await lesson.click();
  const topic = jana.page.getByLabel("Thema der Stunde");
  if (!(await topic.inputValue())) await topic.fill("Gate 2: Wiederholung");
  await jana.page.getByRole("radiogroup", { name: "Lea Schäfer" }).getByText("Fehlt").click();
  await jana.page.getByRole("button", { name: "Eintrag speichern" }).click();
  await expect(jana.page.getByRole("heading", { name: "Meine Stunden" })).toBeVisible();

  // Mutter meldet für diesen Tag krank
  const mutter = await as(browser, "daniela.schaefer");
  await mutter.page.goto("/abwesenheiten");
  await mutter.page.getByLabel("Schüler:in").selectOption({ label: "Lea Schäfer" });
  await mutter.page.getByLabel("Erster Tag").fill(date);
  await mutter.page.getByLabel("Letzter Tag").fill(date);
  await mutter.page.getByLabel("krank").check();
  await mutter.page.getByRole("button", { name: "Abwesenheit melden" }).click();
  await expect(mutter.page.getByRole("status")).toContainText("Klassenleitung ist benachrichtigt");

  // Klassenleitung entschuldigt → Klassenbuch zeigt „entschuldigt“
  await jana.page.goto("/abwesenheiten");
  await jana.page.getByRole("button", { name: "Entschuldigen: Lea Schäfer", exact: true }).click();
  await expect(jana.page.getByText("Alles bearbeitet.")).toBeVisible();
  await jana.page.goto(href);
  const row = jana.page.getByRole("listitem").filter({ has: jana.page.getByRole("radiogroup", { name: "Lea Schäfer" }) });
  await expect(row).toContainText("entschuldigt");
  await jana.page.screenshot({ path: ".data/shots/e2e/gate2-klassenbuch.png", fullPage: true });

  await mutter.page.reload();
  await expect(mutter.page.locator("section", { has: mutter.page.getByRole("heading", { name: "Meine Meldungen" }) })).toContainText("entschuldigt");
  expect([...jana.errors, ...mutter.errors]).toEqual([]);
  await jana.close();
  await mutter.close();
});
