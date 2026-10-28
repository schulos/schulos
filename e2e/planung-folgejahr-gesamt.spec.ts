import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { acknowledgeWarnings, collectErrors, deDate, login, publishVersionAt, undoAndDiscardVersion } from "./helpers";

// SP3-09b (docs/STUNDENPLAN-LEBENSZYKLUS.md §3.1 „Umgesetzt (SP3-09b)“): E2E-Gesamtszenario „Das nächste Schuljahr planen“. Die Sekretärin legt
// 2027/28 an, die Schulleitung startet den Schuljahreswechsel und versetzt **nur die 7b** – als „Klasse 8z“ (eigener Kurzname: keine anderen
// Gruppen werden umbenannt; alle anderen Klassen bleiben ohne Ziel, das merkt nur der Wechsel vor). Die Planung wechselt ins Folgejahr: Vorlage
// „Neues Schuljahr“ (leer) → Matrix „Aus dem Vorjahr übernehmen“ → Zeitwunsch-Fenster fürs Folgejahr (die Lehrkraft sieht, für welches Schuljahr,
// und gibt ab) → Solver-Lauf im Entwurf und Übernahme → Diagnose/Fahrplan (Warnungen quittieren) → Freigabe durch die Schulleitung →
// Veröffentlichen ab dem ersten Schultag des Folgejahrs. Stichprobe: der Plan der Lehrkraft heute bleibt unverändert, ab dem Stichtag steht die 8z
// darin. axe hell und 360 px dunkel auf den neuen Ansichten (Automatisch planen, Zeitwünsche der Planung und der Lehrkraft im Folgejahr).
// Aufräumen (auch nach einem Fehler): Veröffentlichung zurücknehmen und verwerfen, Fenster schließen, Klasse 8z und 2027/28 löschen (Lehraufträge,
// Zeitwünsche, Läufe, Versionen und der Wechsel gehen per Kaskade mit) – spätere Specs sehen die Demo wie vorher. Unabhängig von Wochentag und
// Uhrzeit: Stichtag aus der Vorlage, Fenster ab heute.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const NEXT = "2027/28";
const NEW_CLASS = "Klasse 8z";

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function as(browser: Browser, user: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await login(page, user);
  return { page, errors, close: () => ctx.close() };
}

function ymd(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const toYmd = (de: string) => de.split(".").reverse().join("-");

async function folgejahr(page: Page, action: "anlegen" | "loeschen") {
  await page.goto("/verwaltung/stammdaten?bereich=schuljahre");
  if (action === "anlegen") {
    await page.getByRole("button", { name: "Folgejahr anlegen" }).click();
    await expect(page.getByLabel(`Name ${NEXT}`)).toHaveValue(NEXT);
  } else if ((await page.getByRole("button", { name: `${NEXT} löschen` }).count()) > 0) {
    await page.getByRole("button", { name: `${NEXT} löschen` }).click();
    await expect(page.getByLabel(`Name ${NEXT}`)).toHaveCount(0);
  }
}

test("SP3-09b: Folgejahr anlegen und versetzen → Neues Schuljahr → Matrix → Zeitwünsche → Solver in den Entwurf → Fahrplan → Freigabe → veröffentlichen ab erstem Schultag; laufendes Jahr unverändert", async ({ page, browser }) => {
  test.setTimeout(600_000);
  const sek = await as(browser, "sabine.kowalski");
  sek.page.on("dialog", (d) => void d.accept());
  const sl = await as(browser, "petra.lindner");
  const jana = await as(browser, "jana.brandt");
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  let versionId = "";
  let classId = "";
  await folgejahr(sek.page, "anlegen");
  try {
    // 1) Schuljahreswechsel: nur die 7b wird versetzt (als „Klasse 8z“)
    await sl.page.goto("/verwaltung/schuljahreswechsel");
    await sl.page.getByRole("button", { name: "Schuljahreswechsel starten" }).click();
    const promote = sl.page.getByRole("form", { name: "Versetzung" });
    await expect(promote).toBeVisible();
    for (const input of await promote.getByRole("textbox", { name: / wird zu$/ }).all()) await input.fill("");
    await promote.getByLabel("Klasse 7b wird zu", { exact: true }).fill(NEW_CLASS);
    await promote.getByRole("button", { name: "Versetzung durchführen" }).click();
    await expect(sl.page.getByRole("form", { name: "Versetzung" })).toHaveCount(0);

    // Stichprobe vorher: Plan der Lehrkraft heute (laufendes Schuljahr)
    const janaPlan = jana.page.getByRole("table", { name: /^Mein Stundenplan, KW/ });
    const planAt = async (day: string) => {
      await jana.page.goto("/stundenplan");
      const pick = jana.page.getByRole("form", { name: "Plan am Tag" });
      await pick.getByLabel("Plan am").fill(day);
      await pick.getByRole("button", { name: "Plan zeigen" }).click();
      await expect(jana.page).toHaveURL(new RegExp(`woche=${day}`));
      await expect(janaPlan).toBeVisible();
      return janaPlan.innerText();
    };
    const today = ymd(0);
    const janaToday = await planAt(today);

    // 2) Planung wechselt ins Folgejahr: Vorlage „Neues Schuljahr“ (leer)
    await page.goto("/planung/versionen");
    const bar = page.getByRole("region", { name: "Planungsjahr" });
    await bar.getByLabel("Planungsjahr wählen").selectOption({ label: `${NEXT} (Folgejahr)` });
    await bar.getByRole("button", { name: "Wechseln" }).click();
    await expect(bar).toHaveAttribute("data-rolle", "folgejahr");
    const card = page.getByTestId("vorlage-neues-schuljahr");
    await expect(card.locator('[data-step="wechsel"]')).toHaveAttribute("data-done", "ja");
    const offer = (await card.getByTestId("vorlage-schuljahr").textContent())!.match(/Version (\d+\.\d+) ab (\d{2}\.\d{2}\.\d{4})/)!;
    const from = toYmd(offer[2]!);
    await card.getByLabel("Leer (neu planen)").check();
    await card.getByRole("button", { name: "Entwurf fürs Schuljahr anlegen" }).click();
    await expect(page).toHaveURL(/angelegt=[\w-]+/);
    versionId = new URL(page.url()).searchParams.get("angelegt")!;
    const next = page.getByRole("navigation", { name: "Nächste Schritte" });
    await expect(next.getByRole("link", { name: "Automatisch planen" })).toHaveAttribute("href", `/planung/solver?quelle=${versionId}`);
    await expect(next.getByRole("link", { name: "Zeitwünsche" })).toBeVisible();

    // 3) Matrix im Folgejahr: Lehraufträge der 8z aus dem Vorjahr übernehmen
    await page.goto(`/planung/unterricht?ansicht=matrix&jahrgang=8&vorschlag=vorjahr&quelle=${versionId}`);
    await expect(page.getByRole("note").filter({ hasText: /Vorschläge? aus dem Schuljahr 2026\/27/ })).toBeVisible();
    await page.getByRole("button", { name: /^Änderungen speichern \([1-9]\d*\)$/ }).click();
    await expect(page.getByRole("status").filter({ hasText: /Änderungen? gespeichert\.$/ })).toBeVisible();
    await page.goto(`/planung/unterricht?quelle=${versionId}`);
    const classLink = page.getByRole("link", { name: NEW_CLASS, exact: true }).first();
    classId = new URL((await classLink.getAttribute("href"))!, "http://x").searchParams.get("gruppe")!;
    expect(classId).not.toBe("");

    // 4) Zeitwunsch-Fenster fürs Folgejahr; die Lehrkraft sieht das Schuljahr und gibt ab
    await page.goto("/planung/zeitwuensche");
    await expect(bar).toHaveAttribute("data-rolle", "folgejahr");
    await expect(bar.getByTestId("planungsjahr-hinweis")).toContainText("das laufende Schuljahr 2026/27 bleibt unverändert");
    const windowCard = page.getByRole("article", { name: "Eingabefenster für Lehrkräfte" });
    await expect(windowCard).toContainText(`Eingabefenster für Lehrkräfte · ${NEXT}`);
    const windowForm = windowCard.getByRole("form", { name: "Eingabefenster" });
    await windowForm.getByLabel("Erster Tag").fill(today);
    await windowForm.getByLabel("Letzter Tag").fill(ymd(14));
    await windowForm.getByRole("button", { name: "Fenster speichern" }).click();
    await expect(windowForm.getByRole("status")).toContainText("Gespeichert");
    await page.reload();
    await expect(windowCard).toContainText("Offen");
    await axe(page, "Zeitwünsche im Folgejahr");

    await jana.page.goto("/stundenplan/zeitwuensche");
    await expect(jana.page.getByTestId("zeitwunsch-schuljahr")).toHaveText(`Für den Stundenplan im Schuljahr ${NEXT}`);
    await expect(jana.page.getByText("Eingabe offen")).toBeVisible();
    const grid = jana.page.getByRole("form", { name: "Zeitwünsche Jana Brandt" });
    await grid.getByLabel("Fr 6. Stunde").selectOption("x");
    await grid.getByRole("button", { name: "Zeitwünsche speichern" }).click();
    await expect(grid.getByRole("status")).toContainText("Gespeichert");
    await axe(jana.page, "Meine Zeitwünsche (Folgejahr)");
    await page.reload();
    await expect(windowCard).toContainText(/[1-9]\d* von \d+ Lehrkräften haben abgegeben/);

    // 5) Automatisch planen im Entwurf des Folgejahrs → Übernahme in den Entwurf
    await page.goto("/planung/solver");
    await expect(bar).toHaveAttribute("data-rolle", "folgejahr");
    await expect(page.getByRole("heading", { name: `Läufe im Schuljahr ${NEXT}` })).toBeVisible();
    const form = page.getByRole("form", { name: "Lauf starten" });
    await expect(form.getByLabel("Planen im")).toHaveValue(versionId);
    await expect(form.getByLabel("Planen im").getByRole("option", { name: "Gültiger Plan" })).toHaveCount(0);
    await axe(page, "Automatisch planen im Folgejahr");
    await form.getByLabel("Bezeichnung").fill(`E2E Folgejahr ${Date.now().toString(36)}`);
    await form.getByLabel("Gründlichkeit").selectOption("schnell");
    await form.getByRole("button", { name: "Plan berechnen" }).click();
    await expect(page).toHaveURL(/\/planung\/solver\/[\w-]+$/);
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("heading", { name: "Übernehmen" })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 150_000 });
    await expect(page.getByRole("link", { name: `Alle Läufe im Schuljahr ${NEXT}` })).toBeVisible();
    const toDraft = page.getByRole("form", { name: "In den Entwurf übernehmen" });
    await expect(toDraft.getByLabel("Entwurf", { exact: true })).toHaveValue(versionId);
    await toDraft.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
    await expect(page).toHaveURL(new RegExp(`entwurf=${versionId}&gesetzt=[1-9]`));

    // 6) Diagnose und Fahrplan im Folgejahr: Rücklauf der Zeitwünsche, Warnungen quittieren
    await page.goto(`/planung/unterricht?ansicht=diagnose&quelle=${versionId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Unterrichtsverteilung" })).toBeVisible();
    await page.goto(`/planung/fahrplan?version=${versionId}`);
    await expect(page.locator("[data-schritt]")).toHaveCount(8);
    const wishes = page.locator("[data-schritt=wuensche]");
    await expect(wishes).toContainText(/[1-9]\d* von \d+ Lehrkräften abgegeben/);
    await expect(wishes.getByRole("link", { name: "Zeitwünsche" })).toHaveAttribute("href", /\/planung\/zeitwuensche\?jahr=/);
    await acknowledgeWarnings(page, versionId, "E2E Folgejahr");
    await axe(page, "Fahrplan im Folgejahr");

    // 7) Zur Prüfung geben, Schulleitung gibt frei
    const review = `/planung/versionen/pruefung?version=${versionId}`;
    await page.goto(review);
    await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
    await expect(page.getByRole("status")).toContainText("Zur Prüfung gegeben");
    await sl.page.goto(review);
    await sl.page.getByRole("button", { name: "Freigeben" }).click();
    await expect(sl.page.getByRole("status")).toContainText("Freigegeben");

    // 8) Veröffentlichen ab dem ersten Schultag des Folgejahrs; laufendes Jahr: Plan heute unverändert, ab Stichtag die 8z
    await publishVersionAt(page, versionId, from);
    expect(await planAt(today)).toBe(janaToday);
    const janaFrom = await planAt(from);
    expect(janaFrom).toContain("8z");
    await expect(jana.page.getByTestId("plan-version")).toContainText(`Plan-Version ${offer[1]}`);
    await page.goto("/planung/versionen");
    await expect(page.getByRole("list", { name: "Veröffentlichte Versionen" })).toContainText(`${deDate(from)} – offen`);

    // 9) 360 px, dunkel: Automatisch planen, Zeitwünsche (Planung und Lehrkraft) im Folgejahr
    for (const [who, url] of [
      [page, "/planung/solver"],
      [page, "/planung/zeitwuensche"],
      [jana.page, "/stundenplan/zeitwuensche"],
    ] as const) {
      const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", isMobile: false, storageState: await who.context().storageState() });
      const p = await narrow.newPage();
      const pErrors = collectErrors(p);
      await p.goto(url);
      await expect(p.getByRole("main")).toBeVisible();
      if (url.startsWith("/planung")) await expect(p.getByRole("region", { name: "Planungsjahr" })).toHaveAttribute("data-rolle", "folgejahr");
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      await axe(p, `${url} (360 px, dunkel)`);
      expect(pErrors).toEqual([]);
      await narrow.close();
    }
    expect(jana.errors).toEqual([]);
    expect(sl.errors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    // Aufräumen: Veröffentlichung zurücknehmen und verwerfen, Fenster schließen, Klasse 8z und das Folgejahr löschen
    if (versionId) await undoAndDiscardVersion(page, versionId);
    await page.goto("/planung/zeitwuensche");
    const close = page.getByRole("article", { name: "Eingabefenster für Lehrkräfte" }).getByRole("button", { name: "Fenster schließen" });
    if ((await close.count()) > 0) {
      await close.click();
      await expect(close).toHaveCount(0);
    }
    if (!classId) {
      await sek.page.goto("/verwaltung/gruppen?q=8z");
      const link = sek.page.getByRole("link", { name: NEW_CLASS, exact: true });
      if ((await link.count()) > 0) classId = (await link.first().getAttribute("href"))!.split("/").pop()!;
    }
    if (classId) {
      await sek.page.goto(`/verwaltung/gruppen/${encodeURIComponent(classId)}`);
      if ((await sek.page.getByRole("button", { name: "Löschen" }).count()) > 0) {
        await sek.page.getByRole("button", { name: "Löschen" }).click();
        await expect(sek.page).toHaveURL("/verwaltung/gruppen");
      }
    }
    await folgejahr(sek.page, "loeschen");
    await jana.close();
    await sl.close();
    await sek.close();
  }
  // nach dem Aufräumen: laufendes Schuljahr wieder wie vorher (kein Wechsel mehr, Planung im laufenden Jahr)
  await page.goto("/planung/solver");
  await expect(page.getByRole("region", { name: "Planungsjahr" })).toHaveAttribute("data-rolle", "laufend");
});
