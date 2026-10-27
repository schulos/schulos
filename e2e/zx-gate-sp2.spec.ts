import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, openDirectApply } from "./helpers";

// SP2-11 (docs/STUNDENPLAN-UMBAU.md §7): E2E-Gesamtszenario „Gesamtschule“ für GATE SP2. Das Sekretariat legt für Jahrgang 7 zwei
// Mathe-Kurse (E/G) und zwei Wahlpflichtkurse an; die Stundenplanung (frank.schulte) liest die Unterrichtsverteilung per CSV ein
// (zwei neue Bänder), sieht sie im Fachbedarf und im CSV-Export (der sich wieder einlesen lässt), stellt die Tagesgrenze des
// Jahrgangs ein, rechnet einen Lauf, übernimmt ihn ab Stichtag (Bänder als Kopplung, Tagesgrenzen eingehalten) und nimmt ihn
// zurück. Im Tagesgeschäft steht eine Bereitschaft oben in den Vorschlägen, eine Stunde wird verlegt; die Vertretungsseite der 7b
// läuft auf 360 px nicht seitlich über. Dazu ein A11Y-Durchgang der SP2-Seiten (hell und dunkel).
// TD-07: die Spec legt alle Daten selbst an und räumt sie wieder weg – sie hängt nicht von anderen Specs ab.
// „zx-gate-sp2“: läuft nach zx-gate-sp und vor zy-/zz- (Schuljahreswechsel).

test.describe.configure({ mode: "serial" });

const tag = Date.now().toString(36).slice(-5);
const COURSES = {
  e: { name: `M7 E-Kurs ${tag}`, kind: "kurs", subject: "Mathematik" },
  g: { name: `M7 G-Kurs ${tag}`, kind: "kurs", subject: "Mathematik" },
  wpIf: { name: `WP7 Informatik ${tag}`, kind: "wahlpflicht", subject: "Informatik" },
  wpF: { name: `WP7 Französisch ${tag}`, kind: "wahlpflicht", subject: "Französisch" },
} as const;
const BAND_M = `Mathe 7 E/G ${tag}`;
const BAND_WP = `WP 7 ${tag}`;
const RUN = `GATE SP2 Gesamtschule ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const ids: Partial<Record<keyof typeof COURSES, string>> = {};
let runUrl = "";

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `axe-Befunde auf ${where}`,
  ).toEqual([]);
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Montag in `weeks` Wochen (E2E ohne Demo-Ferien: ein Schultag) */
function mondayIn(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return ymd(d);
}

/** Zahl aus der Fachbedarfs-Tabelle („1.234“, „12,5“) */
async function assignedHours(page: Page, subjectId: string): Promise<number> {
  const text = (await page.locator(`tr[data-fach="${subjectId}"] td`).nth(1).innerText()).trim();
  return Number(text.replace(/\./g, "").replace(",", "."));
}

const csvBody = () =>
  [
    "Klasse/Kurs;Fach;Stunden;Lehrkraft;Doppelstunden;Raumwunsch;Band",
    `${COURSES.e.name};Mathematik;4;KLE;;;${BAND_M}`,
    `${COURSES.g.name};Mathematik;4;HAS;;;${BAND_M}`,
    `${COURSES.wpIf.name};Informatik;2;YIL;;;${BAND_WP}`,
    `${COURSES.wpF.name};Französisch;2;WAG;;;${BAND_WP}`,
    "",
  ].join("\r\n");

test("SP2-11: Kurse des Jahrgangs 7 → CSV-Import mit zwei Bändern → Bänder, Fachbedarf, CSV-Export (wieder einlesbar)", async ({ page, browser }) => {
  test.setTimeout(180_000);
  // Sekretariat legt die Kurse an (die Stundenplanung pflegt keine Gruppen)
  const sek = await (await browser.newContext()).newPage();
  await login(sek, "sabine.kowalski");
  for (const [key, c] of Object.entries(COURSES) as [keyof typeof COURSES, (typeof COURSES)[keyof typeof COURSES]][]) {
    await sek.goto("/verwaltung/gruppen/neu");
    await sek.getByLabel("Name", { exact: true }).fill(c.name);
    await sek.getByLabel("Art", { exact: true }).selectOption(c.kind);
    await sek.getByLabel("Jahrgang", { exact: true }).selectOption("7");
    await sek.getByLabel("Fach", { exact: true }).selectOption({ label: c.subject });
    await sek.getByRole("button", { name: "Anlegen" }).click();
    await expect(sek.getByRole("heading", { name: c.name })).toBeVisible();
    ids[key] = new URL(sek.url()).pathname.split("/").pop()!;
  }
  await sek.context().close();

  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/bedarf");
  const mathBefore = await assignedHours(page, "M");

  // CSV-Import: vier Lehraufträge, zwei neue Bänder
  await page.goto("/planung/unterricht/import");
  await page.getByLabel("CSV-Datei").setInputFiles({ name: "jahrgang7.csv", mimeType: "text/csv", buffer: Buffer.from(csvBody()) });
  await page.getByRole("button", { name: "Prüfen (Vorschau)" }).click();
  await expect(page.getByText(/^4 neu · 0 ändern · 0 unverändert · 0 mit Fehlern/)).toBeVisible();
  await page.getByRole("button", { name: "4 Lehraufträge übernehmen" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Übernommen: 4 neue Lehraufträge, 0 geändert/ })).toBeVisible();

  // Bänder: beide angelegt, je zwei Mitglieder, noch nicht verplant
  await page.goto("/planung/unterricht?ansicht=baender");
  const bandM = page.getByRole("row").filter({ has: page.getByRole("link", { name: BAND_M }) });
  await expect(bandM).toContainText(`${COURSES.e.name} · Mathematik`);
  await expect(bandM).toContainText(`${COURSES.g.name} · Mathematik`);
  const bandWp = page.getByRole("row").filter({ has: page.getByRole("link", { name: BAND_WP }) });
  await expect(bandWp).toContainText(`${COURSES.wpIf.name} · Informatik`);
  await expect(bandWp).toContainText(`${COURSES.wpF.name} · Französisch`);

  // Fachbedarf: das Mathe-Band zählt je Lehrkraft (KLE und HAS je 4 Std.)
  await page.goto("/planung/bedarf");
  expect(await assignedHours(page, "M")).toBe(mathBefore + 8);

  // CSV-Export der Verteilung: enthält die Band-Zeilen und lässt sich unverändert wieder einlesen
  const res = await page.request.get("/api/stundenplan/export/verteilung");
  expect(res.status()).toBe(200);
  const csv = await res.text();
  const lines = csv.split("\r\n");
  expect(lines.find((l) => l.startsWith(`${COURSES.e.name};`))).toMatch(new RegExp(`;4;KLE;.*;${BAND_M.replace(/[/]/g, "\\/")};;$`));
  expect(lines.find((l) => l.startsWith(`${COURSES.wpF.name};`))).toContain(`;${BAND_WP}`);
  await page.goto("/planung/unterricht/import");
  await page.getByLabel("CSV-Datei").setInputFiles({ name: "export.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Prüfen (Vorschau)" }).click();
  await expect(page.getByText(/^0 neu · 0 ändern · \d+ unverändert · 0 mit Fehlern/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("SP2-11: Tagesgrenze Jahrgang 7 → Lauf → Übernahme ab Stichtag (Bänder als Kopplung, Grenzen eingehalten) → zurücknehmen", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // Tagesgrenze des Jahrgangs: höchstens 8 Stunden, Mittag nach der 6., höchstens 4 Nachmittage (Kurse zählen für die Klassen)
  await page.goto("/planung/unterricht?ansicht=tagesgrenzen");
  await page.getByLabel("Jahrgang 7: Stunden je Tag höchstens").fill("8");
  await page.getByLabel("Jahrgang 7: Mittag nach der … Stunde").fill("6");
  await page.getByLabel("Jahrgang 7: Nachmittage je Woche höchstens").fill("4");
  await page.getByRole("button", { name: "Tagesgrenzen speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Tagesgrenzen gespeichert." })).toBeVisible();

  // Lauf (schnell, fester Startwert)
  await page.goto("/planung/solver");
  const form = page.getByRole("form", { name: "Lauf starten" });
  await form.getByLabel("Bezeichnung").fill(RUN);
  await form.getByLabel("Gründlichkeit").selectOption("schnell");
  await form.getByLabel("Startwert").fill("7");
  await form.getByLabel("Gewichtung").selectOption("ausgewogen");
  await form.getByRole("button", { name: "Plan berechnen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\/[\w-]+$/);
  runUrl = page.url();
  await expect(async () => {
    await page.reload();
    // SP3-02: „Übernehmen“ füllt einen Entwurf – die direkte Übernahme (Übergangsweg bis SP3-04) ist eingeklappt
    await expect(page.getByRole("form", { name: "In den Entwurf übernehmen" })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 150_000 });
  await expect(page.getByRole("region", { name: "Protokoll" })).toContainText(/Tagesgrenzen für \d+ Klassen/);

  // Übernahme ab einem Montag in sechs Wochen
  const from = mondayIn(6);
  await openDirectApply(page);
  const applyForm = page.getByRole("form", { name: "Vorschlag übernehmen" });
  await applyForm.getByLabel("ab Stichtag").fill(from);
  await applyForm.getByRole("button", { name: "Ab Stichtag übernehmen" }).click();
  await expect(page).toHaveURL(/uebernommen=\d+/);

  // Bänder liegen als Kopplung im Plan – jede Mathe-Stunde des E-Kurses mit dem G-Kurs, jede WP-Stunde mit dem Partnerkurs
  for (const [key, subject, partner] of [
    ["e", "Mathematik", COURSES.g.name],
    ["wpIf", "Informatik", COURSES.wpF.name],
  ] as const) {
    await page.goto(`/planung/stundenplan?gruppe=${ids[key]}&stand=${from}`);
    const links = page.getByRole("table", { name: `Stundenplan ${COURSES[key].name}` }).getByRole("link", { name: new RegExp(`^${subject}`) });
    await expect(links.first()).toBeVisible();
    const n = await links.count();
    for (let i = 0; i < n; i++) {
      await expect(links.nth(i)).toContainText("Kopplung");
      await expect(links.nth(i)).toContainText(partner);
    }
  }
  // Diagnose am Stichtag: Tagesgrenzen eingehalten, Bänder vollständig zur selben Zeit
  await page.goto(`/planung/unterricht?ansicht=diagnose&kategorie=day&stichtag=${from}`);
  await expect(page.getByText("Tagesgrenzen: alles in Ordnung")).toBeVisible();
  await page.goto(`/planung/unterricht?ansicht=diagnose&kategorie=band&stichtag=${from}`);
  await expect(page.getByRole("main")).not.toContainText(BAND_M);
  await expect(page.getByRole("main")).not.toContainText(BAND_WP);

  // zurücknehmen und Lauf löschen
  await page.goto(runUrl);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Übernahme zurücknehmen" }).click();
  await expect(page).toHaveURL(/zurueckgenommen=\d+/);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Lauf löschen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\?geloescht=1$/);
  runUrl = "";
  await page.goto(`/planung/stundenplan?gruppe=${ids.e}&stand=${from}`);
  await expect(page.getByRole("table", { name: `Stundenplan ${COURSES.e.name}` }).getByRole("link", { name: /^Mathematik/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

const lessonForms = (page: Page) => page.getByRole("form", { name: /^\d+\. Std · .+ · Klasse 7b$/ });

test("SP2-11: Tagesgeschäft – Bereitschaft oben in den Vorschlägen, Verlegung in eine freie Stunde; Vertretungsseite der 7b auf 360 px ohne Überlauf", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen?gruppe=g-7b");
  const date = await page.getByLabel("Datum").inputValue();
  const weekday = (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
  const first = lessonForms(page).first();
  const label = (await first.getAttribute("aria-label"))!;
  const period = Number(label.split(".")[0]);

  // Bereitschaft für genau diese Stunde: die erste Lehrkraft, die dann frei ist
  await page.goto("/planung/vertretungen/bereitschaft");
  const standby = page.getByRole("form", { name: "Bereitschaft eintragen" });
  const teachers = await standby.getByLabel("Lehrkraft").locator("option").count();
  let code = "";
  for (let i = 1; i < teachers && !code; i++) {
    // je Versuch frisch laden: sonst setzt die Antwort des vorigen (abgelehnten) Versuchs das Formular zurück, während schon der
    // nächste gewählt ist, und die alte Meldung gilt als Antwort (SQ-01: im neuen Demo-Plan ist die erste Lehrkraft nicht frei)
    if (i > 1) await page.goto("/planung/vertretungen/bereitschaft");
    await standby.getByLabel("Lehrkraft").selectOption({ index: i });
    await standby.getByLabel("Wochentag").selectOption(String(weekday));
    await standby.getByLabel("Stunde").selectOption(String(period));
    const chosen = (await standby.getByLabel("Lehrkraft").locator("option:checked").innerText()).split(" – ")[0]!;
    await standby.getByRole("button", { name: "Eintragen" }).click();
    await expect(standby.getByRole("status").or(standby.getByRole("alert"))).toBeVisible();
    if ((await standby.getByRole("status").count()) > 0) code = chosen;
  }
  expect(code).not.toBe("");

  // Vorschläge der Stunde: die Bereitschaft steht oben → übernehmen
  await page.goto(`/planung/vertretungen?gruppe=g-7b&datum=${date}`);
  const top = page.getByRole("group", { name: `Vorschläge: ${label}` }).getByRole("listitem").first();
  await expect(top).toContainText("Bereitschaft");
  await top.getByRole("button", { name: `${code} übernehmen: ${label}` }).click();
  const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
  await expect(day.getByRole("row").filter({ hasText: code })).not.toHaveCount(0);

  // Verlegung: die letzte Stunde des Tages in eine freie Stunde (erste Zielstunde, in der Gruppe, Lehrkraft und Raum frei sind)
  const forms = lessonForms(page);
  const last = forms.last();
  const lastLabel = (await last.getAttribute("aria-label"))!;
  await last.getByRole("radio", { name: "Verlegung" }).check();
  const targets = await last.getByLabel("Verlegen in").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  let movedTo = "";
  for (const t of targets.reverse()) {
    const f = page.getByRole("form", { name: lastLabel });
    await f.getByRole("radio", { name: "Verlegung" }).check();
    await f.getByLabel("Verlegen in").selectOption(t);
    await f.getByRole("button", { name: "Speichern" }).click();
    await expect(f.getByRole("status").or(f.getByRole("alert"))).toBeVisible();
    if ((await f.getByRole("status").count()) > 0) movedTo = t;
    if (movedTo) break;
  }
  expect(movedTo).not.toBe("");
  await page.reload();
  await expect(day.getByText(`verlegt in die ${movedTo}. Std.`)).toBeVisible();

  // 360 px: mit Vertretung und Verlegung kein seitliches Scrollen
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  for (const path of [`/planung/vertretungen?gruppe=g-7b&datum=${date}`, "/planung/vertretungen/bereitschaft"]) {
    await p.goto(path);
    await p.waitForLoadState("load");
    const { overflow, wide } = await p.evaluate(() => {
      const w = document.documentElement.clientWidth;
      // Elemente, die am weitesten rechts herausragen (für die Fehlermeldung)
      const wide = [...document.querySelectorAll("body *")]
        .map((e) => ({ e, right: e.getBoundingClientRect().right }))
        .filter((x) => x.right > w + 1)
        .sort((x, y) => y.right - x.right)
        .slice(0, 3)
        .map(({ e, right }) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 3).join(".")} (${Math.round(right)} px)`);
      return { overflow: document.documentElement.scrollWidth - w, wide };
    });
    expect(overflow, `${path} (360 px): ${wide.join(" | ")}`).toBeLessThanOrEqual(0);
  }
  await p.screenshot({ path: ".data/shots/e2e/gate-sp2-vertretung-360.png", fullPage: true });
  await narrow.close();

  // aufheben: alle Änderungen der 7b, Bereitschaft entfernen
  for (let n = 0; n < 6 && (await day.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).count()) > 0; n++) {
    const before = await day.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).count();
    await day.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).first().click();
    await expect.poll(() => day.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).count()).toBeLessThan(before);
  }
  await expect(day.getByRole("button", { name: /^Aufheben: Klasse 7b/ })).toHaveCount(0);
  await page.goto("/planung/vertretungen/bereitschaft");
  const remove = page.getByRole("button", { name: new RegExp(`^Bereitschaft ${code} \\S+ ${period}\\. Std entfernen$`) });
  await remove.click();
  await expect(remove).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("SP2-11: A11Y-Durchgang der SP2-Seiten – hell und dunkel", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, "frank.schulte");
  const pages = [
    "/planung/unterricht?ansicht=baender",
    "/planung/unterricht?ansicht=tagesgrenzen",
    "/planung/unterricht?ansicht=lehrkraefte&lehrkraft=u-frank.schulte",
    "/planung/unterricht?ansicht=diagnose&kategorie=band",
    "/planung/unterricht?ansicht=diagnose&kategorie=prefs",
    "/planung/unterricht/import",
    "/planung/bedarf",
    "/planung/vertretungen/bereitschaft",
    "/druck/stundenplan/uebersicht?art=gesamt-klassen",
    "/druck/stundenplan/uebersicht?art=verteilung",
  ];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of pages) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await axe(page, `${path} (${scheme})`);
    }
  }
});

test("SP2-11: Aufräumen – Lauf, Lehraufträge, Bänder, Kurse, Tagesgrenze", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, "frank.schulte");
  if (runUrl) {
    await page.goto(runUrl);
    if ((await page.getByRole("button", { name: "Übernahme zurücknehmen" }).count()) > 0) {
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Übernahme zurücknehmen" }).click();
      await expect(page).toHaveURL(/zurueckgenommen=\d+/);
    }
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Lauf löschen" }).click();
  }
  for (const [key, c] of Object.entries(COURSES) as [keyof typeof COURSES, (typeof COURSES)[keyof typeof COURSES]][]) {
    if (!ids[key]) continue;
    await page.goto(`/planung/unterricht?gruppe=${ids[key]}`);
    const link = page.getByRole("row").filter({ hasText: c.subject }).getByRole("link", { name: c.subject, exact: true });
    if ((await link.count()) === 0) continue;
    await link.first().click();
    await page.getByRole("button", { name: "Lehrauftrag löschen" }).click();
    await expect(page).not.toHaveURL(/auftrag=/);
  }
  for (const band of [BAND_M, BAND_WP]) {
    await page.goto("/planung/unterricht?ansicht=baender");
    const link = page.getByRole("link", { name: band, exact: true });
    if ((await link.count()) === 0) continue;
    await link.click();
    await page.getByRole("button", { name: "Band löschen" }).click();
    await expect(page.getByRole("link", { name: band, exact: true })).toHaveCount(0);
  }
  await page.goto("/planung/unterricht?ansicht=tagesgrenzen");
  await page.getByLabel("Jahrgang 7: Nachmittage je Woche höchstens").fill("3");
  await page.getByRole("button", { name: "Tagesgrenzen speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Tagesgrenzen gespeichert." })).toBeVisible();

  const sek = await (await browser.newContext()).newPage();
  await login(sek, "sabine.kowalski");
  sek.on("dialog", (d) => void d.accept());
  for (const key of Object.keys(COURSES) as (keyof typeof COURSES)[]) {
    if (!ids[key]) continue;
    await sek.goto(`/verwaltung/gruppen/${ids[key]}`);
    await sek.getByRole("button", { name: "Löschen" }).click();
    await expect(sek).toHaveURL("/verwaltung/gruppen");
  }
  await sek.context().close();
});
