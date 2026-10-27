import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, sendPlannedNow } from "./helpers";

// VT-05 (docs/STUNDENPLAN-LEBENSZYKLUS.md §7.1): E2E-Szenario „Morgen“ für GATE VT. Am nächsten Schultag fällt eine Lehrkraft der 7b
// aus. Die Stundenplanung trägt die Abwesenheit ein, sieht die offenen Stunden mit Ampel auf dem Arbeitsplatz, übernimmt den ersten
// Vorschlag per Taste „1“, setzt Grund-Kategorie, öffentlichen Hinweis und interne Notiz, hinterlegt Material (an der Stunde der
// Abwesenden und, ohne Abwesenheit, an einer anderen Stunde) und veröffentlicht den Tag. Die Kopfleiste zeigt „Gong geplant …“, „jetzt
// senden“ löst die Benachrichtigungen aus. Schülerin und Monitor sehen den groben Grund und den Hinweis, nie die interne Notiz oder den
// Abwesenheitsgrund. Die Vertretungslehrkraft sieht in „Meine Vertretungen“ den internen Hinweis und das Material und bestätigt mit
// „Gesehen“, die Planung sieht die Kenntnisnahme. Dazu axe hell/dunkel auf dem Arbeitsplatz und 360 px.
// TD-07: die Spec legt alles selbst an und räumt am Ende auf (Änderungen, Abwesenheit, Material).
// „zx-gate-vt“: läuft nach zx-gate-sp2 und vor zy-/zz- (Schuljahreswechsel).

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).include("main").withTags(TAGS).analyze();
  expect(
    r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`)),
    `axe-Befunde auf ${where}`,
  ).toEqual([]);
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Morgen – am Wochenende der Montag (die E2E-Datenbank hat keine Ferien). */
function tomorrowSchoolDay(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return ymd(d);
}

const stundeOf = (url: string) => new URL(url).searchParams.get("stunde");

/** „Jana Brandt“ → „jana.brandt“ (Demo-Konten: Vorname.Nachname ohne Umlaute) */
const usernameOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, ".");

test("GATE VT: Morgen – Abwesenheit → Arbeitsplatz → Vorschlag per Tastatur → Hinweise/Material → veröffentlichen → Gong → Schüler ohne interne Infos → Kenntnisnahme", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const PUBLIC = "VT05-E2E Bitte Heft mitbringen";
  const SECRET = "VT05-E2E intern Schlüssel im Sekretariat";
  const TASK = "VT05-E2E Buch S. 12";
  const TASK_OTHER = "VT05-E2E ohne Abwesenheit";
  const date = tomorrowSchoolDay();
  const errors = collectErrors(page);

  // 1) Planung: Welche Lehrkraft hat morgen die 7b? (Kürzel aus den Stundenkarten der Klasse)
  await login(page, "frank.schulte");
  await page.goto(`/planung/vertretungen?datum=${date}&gruppe=g-7b`);
  // Die Demo-Daten haben an dem Tag schon Änderungen: nur Stunden ohne Änderung kommen in Frage.
  const cardLabel = page.locator('xpath=//span[starts-with(normalize-space(.),"Klasse 7b · ")]');
  await expect(cardLabel.first()).toBeVisible();
  const free = await cardLabel.evaluateAll((els) =>
    els.flatMap((el) => {
      const text = (el.closest("div.justify-between") as HTMLElement | null)?.innerText ?? "";
      const code = /^Klasse 7b · ([A-ZÄÖÜ]{2,4})( · |$)/.exec(el.textContent!.trim())?.[1];
      return code && !/Vertretung|Entfall|Raumänderung|Verleg|Zusammen|Betreuung/.test(text) ? [code] : [];
    }),
  );
  const absent = free[0]!;
  const other = free.find((c) => c !== absent);
  expect(absent, "unveränderte 7b-Stunde morgen").toBeTruthy();
  expect(other, "zweite Lehrkraft ohne Änderung in der 7b morgen").toBeTruthy();

  // 1) Abwesenheit für morgen
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const absence = page.getByRole("form", { name: "Abwesenheit eintragen" });
  const option = absence.getByLabel("Lehrkraft", { exact: true }).locator("option").filter({ hasText: new RegExp(`^${absent} – `) }).first();
  await absence.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: (await option.textContent())! });
  await absence.getByLabel("Grund").selectOption({ label: "krank" });
  await absence.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();

  // 2) Arbeitsplatz: offene Stunden mit Ampel, Deeplink auf die gewählte Stunde
  const needs = page.getByRole("table", { name: "Offene Stunden abwesender Lehrkräfte" });
  const openRows = needs.getByRole("row").filter({ hasText: "offen" });
  await expect(openRows.first()).toContainText(/noch Zeit|heute|dringend/);
  const header = page.getByRole("list", { name: "Tagesstand" });
  await expect(header).toContainText(/\d+ offen/);
  await openRows.first().getByRole("link", { name: "Vertretung eintragen" }).click();
  await expect(page).toHaveURL(/stunde=/);
  const first = stundeOf(page.url())!;
  const chosen = page.getByRole("article", { name: /^Gewählte Stunde:/ });
  await expect(chosen).toBeVisible();
  await expect(page.getByRole("list", { name: /^Tagesplan / })).toBeVisible();

  // 3) Vorschlag per Tastatur: „1“ übernimmt den ersten (→ nächste offene Stunde, ?gespeichert=1), ↑ zurück zur ersten Stunde
  const cards = chosen.getByRole("group", { name: /^Vorschläge:/ }).getByRole("list").first().getByRole("listitem");
  await expect(cards.first()).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  if ((await openRows.count()) > 1) {
    // ↓ nächste offene Stunde, ↑ zurück
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => stundeOf(page.url())).not.toBe(first);
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => stundeOf(page.url())).toBe(first);
  }
  const changes = page.getByRole("region", { name: /^Alle Änderungen am/ });
  await page.keyboard.press("1");
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert – das ist die nächste offene Stunde." })).toBeVisible();
  await expect(page).toHaveURL(/gespeichert=1/);
  await expect(changes.getByRole("row")).not.toHaveCount(0);
  // war das die einzige offene Stunde, bleibt die Ansicht stehen; sonst springt sie zur nächsten offenen – zurück zur eben übernommenen
  await page.goto(`/planung/vertretungen?datum=${date}&stunde=${first}`);
  await expect(page.getByRole("article", { name: /^Gewählte Stunde:/ })).toBeVisible();

  // 3) Grund-Kategorie, öffentlicher Hinweis, interne Notiz, Material (mit Abwesenheit) an dieser Stunde
  const lessonForm = page.getByRole("article", { name: /^Gewählte Stunde:/ }).getByRole("form").first();
  await lessonForm.getByLabel("Grund (öffentlich)").selectOption({ label: "Lehrkraft abwesend" });
  await lessonForm.getByLabel("Hinweis für Schüler:innen").fill(PUBLIC);
  await lessonForm.getByLabel("Interne Notiz (nur Planung und Vertretung)").fill(SECRET);
  await lessonForm.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
  await page.goto(`/planung/vertretungen?datum=${date}&stunde=${first}`);
  const lesson = page.getByRole("article", { name: /^Gewählte Stunde:/ });
  await expect(lesson.getByLabel("Interne Notiz (nur Planung und Vertretung)")).toHaveValue(SECRET);
  await lesson.getByText(/^Material für die Vertretung/).click();
  const material = lesson.getByRole("form", { name: /^Material / });
  await material.getByLabel("Arbeitsauftrag").fill(TASK);
  await material.getByRole("button", { name: "Material speichern" }).click();
  await expect(material.getByRole("status")).toContainText("Material gespeichert.");

  // die vertretende Lehrkraft (Kürzel aus der Änderungsliste) und ihr Konto
  const row = page.getByRole("region", { name: /^Alle Änderungen am/ }).getByRole("row").filter({ hasText: PUBLIC });
  await expect(row).toBeVisible();
  const substituteCode = (await row.getByRole("cell").filter({ hasText: /^[A-ZÄÖÜ]{2,4}$/ }).first().innerText()).trim();
  expect(substituteCode, "Vertretungslehrkraft in der Änderungsliste").toBeTruthy();
  const substituteLabel = (await absence.getByLabel("Lehrkraft", { exact: true }).locator("option").filter({ hasText: new RegExp(`^${substituteCode} – `) }).first().textContent())!;
  const substituteUser = usernameOf(substituteLabel.replace(/^[^–]+– /, ""));

  // 3) Material ohne Abwesenheit an einer anderen Stunde der 7b (Lehrkraft ist nicht abwesend)
  await page.goto(`/planung/vertretungen?datum=${date}&gruppe=g-7b`);
  await page
    .locator(`xpath=//span[starts-with(normalize-space(.),"Klasse 7b · ${other}")]/ancestor::div[contains(@class,"justify-between")][1]//a[starts-with(@aria-label,"Stunde wählen")]`)
    .first()
    .click();
  const otherLesson = page.getByRole("article", { name: /^Gewählte Stunde:/ });
  await expect(page).toHaveURL(/stunde=/);
  const otherId = stundeOf(page.url())!;
  expect(otherId).not.toBe(first);
  await otherLesson.getByText(/^Material für die Vertretung/).click();
  const otherMaterial = otherLesson.getByRole("form", { name: /^Material / });
  await otherMaterial.getByLabel("Arbeitsauftrag").fill(TASK_OTHER);
  await otherMaterial.getByRole("button", { name: "Material speichern" }).click();
  await expect(otherMaterial.getByRole("status")).toContainText("Material gespeichert.");

  // 4) Tag veröffentlichen → Kopfleiste „Gong geplant …“ (zwischen 18 und 20 Uhr geht es sofort raus, dann gibt es nichts Geplantes)
  await page.goto(`/planung/vertretungen?datum=${date}`);
  // (Ist der Tag schon veröffentlicht, gelten die Änderungen sofort und reihen die Nachricht selbst ein.)
  const publish = page.getByRole("button", { name: "Tag veröffentlichen" });
  if (await publish.count()) {
    await publish.click();
    await expect(page.getByRole("status").filter({ hasText: "Veröffentlicht" })).toBeVisible();
  }
  const gong = page.getByRole("list", { name: "Tagesstand" }).getByText(/^Gong (geplant|fällig) .*\(\d+\)$/);
  if (await gong.count()) {
    await expect(gong.first()).toBeVisible();
    await expect(page.getByRole("list", { name: "Geplante Nachrichten" })).toContainText(/geplant für/);
  }
  await axeClean(page, "Arbeitsplatz mit Gong-Kopfleiste (hell)");
  await sendPlannedNow(page);
  await expect(page.getByRole("list", { name: "Geplante Nachrichten" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Tagesstand" }).getByText(/^Gong (geplant|fällig)/)).toHaveCount(0);

  // 5) Schülerin: Grund-Kategorie und Hinweis ja, interne Notiz und Abwesenheitsgrund nie – Plan, Gong
  const sctx = await browser.newContext();
  const lea = await sctx.newPage();
  const leaErrors = collectErrors(lea);
  await login(lea, "lea.schaefer");
  await lea.goto("/stundenplan/vertretungen");
  const klasse = lea.getByRole("article", { name: "7b" }).first();
  await expect(klasse).toContainText(PUBLIC);
  await expect(klasse).toContainText("Grund: Lehrkraft abwesend");
  const main = lea.getByRole("main");
  await expect(main).not.toContainText(SECRET);
  await expect(main).not.toContainText(/krank/i);
  await expect(main).not.toContainText(TASK_OTHER);
  await lea.getByRole("button", { name: /Gong/ }).click();
  const dialog = lea.getByRole("dialog", { name: "Gong" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(PUBLIC).first()).toBeVisible();
  await expect(dialog).not.toContainText(SECRET);
  await expect(dialog).not.toContainText(/krank/i);
  await sctx.close();

  // 5) Monitor (ohne Anmeldung): kein interner Hinweis, kein Abwesenheitsgrund
  const mctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const monitor = await mctx.newPage();
  await monitor.goto("/monitor/demo-foyer-lindenhof-2026");
  await expect(monitor.getByRole("heading", { name: "Vertretungsplan" })).toBeVisible();
  await expect(monitor.locator("body")).not.toContainText(SECRET);
  await expect(monitor.locator("body")).not.toContainText(/krank/i);
  await mctx.close();

  // 6) Vertretungslehrkraft: „Meine Vertretungen“ mit internem Hinweis und Material, „Gesehen“
  const tctx = await browser.newContext();
  const teacher = await tctx.newPage();
  const teacherErrors = collectErrors(teacher);
  await login(teacher, substituteUser);
  await teacher.goto("/stundenplan/vertretungen");
  const own = teacher.getByRole("article", { name: "Meine Vertretungen" });
  await expect(own).toContainText(SECRET);
  await expect(own.getByRole("link", { name: "Material zur Stunde" })).toBeVisible();
  const item = own.getByRole("listitem").filter({ hasText: PUBLIC });
  await item.getByRole("button", { name: /^Gesehen:/ }).click();
  await expect(item.getByText("Gesehen", { exact: true })).toBeVisible();
  await tctx.close();

  // 6) Planung sieht die Kenntnisnahme
  await page.goto(`/planung/vertretungen?datum=${date}&stunde=${first}`);
  await expect(page.getByRole("article", { name: /^Gewählte Stunde:/ }).getByText("gesehen", { exact: true })).toBeVisible();

  // 7) axe hell/dunkel auf dem Arbeitsplatz, 360 px kurz
  await axeClean(page, "Arbeitsplatz (hell)");
  await page.emulateMedia({ colorScheme: "dark" });
  await axeClean(page, "Arbeitsplatz (dunkel)");
  await page.emulateMedia({ colorScheme: "light" });
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, storageState: await page.context().storageState() });
  const small = await narrow.newPage();
  const smallErrors = collectErrors(small);
  await small.goto(page.url());
  await expect(small.getByRole("article", { name: /^Gewählte Stunde:/ })).toBeVisible();
  expect(await small.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axeClean(small, "Arbeitsplatz 360 px (hell)");
  await small.emulateMedia({ colorScheme: "dark" });
  await axeClean(small, "Arbeitsplatz 360 px (dunkel)");
  await narrow.close();

  // aufräumen: Material, Änderungen, Abwesenheit
  for (const [id, text] of [[first, TASK], [otherId, TASK_OTHER]] as const) {
    await page.goto(`/planung/vertretungen?datum=${date}&gruppe=g-7b&stunde=${id}`);
    const l = page.getByRole("article", { name: /^Gewählte Stunde:/ });
    const f = l.getByRole("form", { name: /^Material / });
    // liegt Material vor, ist der Aufklapper schon offen
    if (!(await f.isVisible())) await l.getByText(/^Material für die Vertretung/).click();
    await expect(f.getByLabel("Arbeitsauftrag")).toHaveValue(text);
    await f.getByLabel("Arbeitsauftrag").fill("");
    await f.getByRole("button", { name: "Material speichern" }).click();
    await expect(f.getByRole("status")).toContainText("Material gelöscht.");
  }
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const mine = page.getByRole("region", { name: /^Alle Änderungen am/ }).getByRole("row").filter({ hasText: PUBLIC });
  await mine.getByRole("button", { name: /^Aufheben:/ }).click();
  await expect(mine).toHaveCount(0);
  await page.getByRole("button", { name: `Abwesenheit ${absent} aufheben` }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();
  expect([...errors, ...leaErrors, ...teacherErrors, ...smallErrors]).toEqual([]);
});
