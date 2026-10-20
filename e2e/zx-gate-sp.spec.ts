import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch, publishIfDraft } from "./helpers";

// SP-11 (docs/STUNDENPLAN-UMBAU.md §5): E2E-Gesamtszenario „Stundenplaner:in“ für GATE SP. Frank Schulte (Lehrkraft, Funktionsgruppe
// „Stundenplanung“) plant ohne Verwaltungszugang: Übersicht → Lauf mit Parametern → Abbruch → weitere Läufe → Vergleich → Übernahme
// ab Stichtag → zurücknehmen; dazu eine Vertretung mit Fachtausch („Mathematik statt Sport“). Das Sekretariat kommt nicht in den
// Bereich, alte /verwaltung/…-Lesezeichen leiten weiter. A11Y-Durchgang aller Planungsseiten (hell und dunkel, auch die Detail- und
// Vergleichsseite) und die Vergleichsseite auf 360 px ohne Seitenüberlauf.
// 2FA: Planungsrechte verlangen die Zwei-Faktor-Anmeldung sofort (S80, `requiresTwoFactor`, permissions.test.ts). Die E2E-DB ist
// eine Demo-Instanz – dort ist 2FA freiwillig; geprüft wird hier, dass die Seite die Pflicht für das Planungskonto nennt.
// „zx-“: läuft nach den Einzel-Specs und vor zz-gate4c (Schuljahreswechsel). Jeder Schritt räumt seine Läufe/Vertretungen auf.

test.describe.configure({ mode: "serial" });

const tag = Date.now().toString(36);
const A = `GATE SP gründlich ${tag}`;
const B = `GATE SP raumtreu ${tag}`;
const C = `GATE SP ausgewogen ${tag}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const runs: Record<string, string> = {};
let compareUrl = "";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function sundayIn(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  return ymd(d);
}

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `axe-Befunde auf ${where}`,
  ).toEqual([]);
}

async function startRun(page: Page, opts: { label: string; effort: string; preset: string; seed?: string; weights?: Record<string, string> }) {
  await page.goto("/planung/solver");
  const form = page.getByRole("form", { name: "Lauf starten" });
  await form.getByLabel("Bezeichnung").fill(opts.label);
  await form.getByLabel("Gründlichkeit").selectOption(opts.effort);
  if (opts.seed) await form.getByLabel("Startwert").fill(opts.seed);
  await form.getByLabel("Gewichtung").selectOption(opts.preset);
  for (const [label, value] of Object.entries(opts.weights ?? {})) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole("button", { name: "Plan berechnen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: opts.label, level: 1 })).toBeVisible();
  return page.url();
}

const historyRow = (page: Page, label: string) =>
  page.getByRole("table", { name: /Läufe der automatischen Planung/ }).getByRole("row").filter({ has: page.getByRole("link", { name: label }) });

test("GATE SP: Stundenplaner:in – Übersicht → Lauf mit Parametern → Abbruch → zwei Läufe → Vergleich → Übernahme ab Stichtag → zurücknehmen", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // 2FA-Pflicht der Funktionsgruppe: in einer echten Schule Pflicht, in der Demo freiwillig
  await page.goto("/zwei-faktor");
  await expect(page.getByText("In einer echten Schule wäre sie für dein Konto Pflicht; in dieser Demo ist sie freiwillig.")).toBeVisible();

  // Übersicht über die Hauptnavigation; Planung ohne Verwaltung
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav.getByRole("link", { name: "Verwaltung" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Stundenplanung" }).click();
  await expect(page).toHaveURL("/planung");
  await expect(page.getByRole("region", { name: "Jahresplanung" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Tagesgeschäft" })).toBeVisible();
  await page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Automatisch planen" }).click();
  await expect(page).toHaveURL("/planung/solver");

  // 1. Lauf mit Parametern (gründlich, eigener Startwert, eigene Gewichte) → abbrechen
  runs.A = await startRun(page, {
    label: A,
    effort: "gruendlich",
    preset: "eigene",
    seed: "4711",
    weights: { "Hohlstunde Lehrkraft": "9", "Grenze späte Stunden": "5" },
  });
  await page.getByRole("form", { name: "Lauf abbrechen" }).getByRole("button", { name: "Abbrechen" }).click();
  await expect(page).toHaveURL(runs.A);
  // vor der fertigen Konstruktion: abgebrochen ohne Plan; danach: vorzeitig beendet mit gültigem Plan
  await expect(page.getByText(/abgebrochen, bevor ein Plan entstand|Vorzeitig beendet bei \d+ %/).first()).toBeVisible({ timeout: 90_000 });
  const params = page.getByRole("table", { name: "Gewichte des Laufs" });
  await expect(params.getByRole("row", { name: /Hohlstunde Lehrkraft 9/ })).toBeVisible();
  await expect(params.getByRole("row", { name: /Grenze späte Stunden 5/ })).toBeVisible();
  await expect(page.getByText("4711", { exact: true })).toBeVisible();

  // 2. zwei schnelle Läufe mit verschiedenen Voreinstellungen
  runs.B = await startRun(page, { label: B, effort: "schnell", preset: "raumtreu", seed: "17" });
  runs.C = await startRun(page, { label: C, effort: "schnell", preset: "ausgewogen", seed: "17" });
  await page.goto("/planung/solver");
  await expect(async () => {
    await page.reload();
    for (const label of [B, C]) await expect(historyRow(page, label).getByText("fertig")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 120_000 });
  await expect(historyRow(page, A)).toContainText(/abgebrochen|fertig/);
  await expect(historyRow(page, A)).toContainText("gründlich · eigene");

  // 3. Vergleich aus der Historie
  const compare = page.getByRole("form", { name: "Läufe vergleichen" });
  await historyRow(page, B).getByRole("checkbox").check();
  await historyRow(page, C).getByRole("checkbox").check();
  await compare.getByRole("button", { name: "Ausgewählte Läufe vergleichen" }).click();
  await expect(page).toHaveURL(/\/planung\/solver\/vergleich\?laeufe=[\w-]+,[\w-]+$/);
  compareUrl = page.url();
  const kenn = page.getByRole("table", { name: /Kennzahlen der verglichenen Läufe/ });
  for (const label of [B, C]) await expect(kenn.getByRole("columnheader", { name: new RegExp(label) })).toBeVisible();
  await expect(kenn.getByRole("row", { name: /^Bewertung/ }).getByRole("cell")).toHaveCount(2);
  await expect(page.getByRole("table", { name: /Parameter der verglichenen Läufe/ }).getByRole("row", { name: /^Gewichtung/ })).toContainText("abweichend");

  // 4. Übernahme des letzten Laufs ab Stichtag (Schultag) → Plan ab Stichtag neu, Übersicht „übernommen“
  await page.goto(runs.C);
  const applyForm = page.getByRole("form", { name: "Vorschlag übernehmen" });
  await expect(page.getByTestId("apply-preview")).toBeVisible();
  await applyForm.getByLabel("ab Stichtag").fill(sundayIn(6));
  await applyForm.getByRole("button", { name: "Ab Stichtag übernehmen" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Stichtag" });
  await expect(alert).toContainText("kein Schultag");
  const from = (await alert.textContent())!.match(/nächster Schultag: (\d{4}-\d{2}-\d{2})/)![1]!;
  const planUrl = `/planung/stundenplan?gruppe=g-7b&stand=${from}`;
  const plan = page.getByRole("table", { name: "Stundenplan Klasse 7b" });
  await page.goto(planUrl);
  const before = await plan.innerText();

  await page.goto(runs.C);
  await applyForm.getByLabel("ab Stichtag").fill(from);
  await applyForm.getByRole("button", { name: "Ab Stichtag übernehmen" }).click();
  await expect(page).toHaveURL(/uebernommen=\d+/);
  await expect(page.getByRole("status").filter({ hasText: /\d+ Stunden übernommen/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lauf löschen" })).toHaveCount(0);
  await page.goto(planUrl);
  expect(await plan.innerText()).not.toBe(before);
  await page.goto("/planung");
  const tile = page.locator("[data-kachel=solver]");
  await expect(tile).toContainText("übernommen");
  await expect(tile).toContainText("gilt ab");

  // 5. zurücknehmen → alter Plan, Lauf wieder „fertig“
  await page.goto(runs.C);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Übernahme zurücknehmen" }).click();
  await expect(page).toHaveURL(/zurueckgenommen=\d+/);
  await expect(page.getByRole("status").filter({ hasText: "Übernahme zurückgenommen" })).toBeVisible();
  await page.goto(planUrl);
  expect(await plan.innerText()).toBe(before);
  await page.goto("/planung");
  await expect(page.locator("[data-kachel=solver]")).toContainText("fertig");
  expect(errors).toEqual([]);
});

test("SP2-02: Band „Q1 GK-Schiene A“ liegt als Kopplung im Plan; die Setzhilfe setzt und verschiebt ein Band als Einheit", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // Demo-Band: die drei Englisch-Stunden des Kurses sind je eine Kopplung mit dem Deutsch- und dem Biologie-Kurs (Raum je Teil)
  await page.goto("/planung/stundenplan?gruppe=g-q1-e-gk1");
  const q1 = page.getByRole("table", { name: "Stundenplan Q1 Englisch GK1" });
  const english = q1.getByRole("link", { name: /^Englisch/ });
  await expect(english).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(english.nth(i)).toContainText("Kopplung");
    await expect(english.nth(i)).toContainText("Q1 Deutsch GK1");
    await expect(english.nth(i)).toContainText("Q1 Biologie GK1");
  }

  // eigenes Band für zwei AGs (verschiedene Fächer, Lehrkräfte und Raumwünsche): Band anlegen, zwei Lehraufträge aufnehmen
  const bandName = `GATE SP2 Band ${tag}`;
  await page.goto("/planung/unterricht?ansicht=baender");
  await page.getByRole("link", { name: "Band anlegen" }).click();
  await page.getByLabel("Name des Bands").fill(bandName);
  await page.getByLabel("Wochenstunden").fill("1");
  await page.getByRole("button", { name: "Band speichern" }).click();
  await expect(page.getByRole("heading", { name: `Band bearbeiten · ${bandName}` })).toBeVisible();
  for (const [group, subject, teacher] of [
    ["g-ag-robotik", "Informatik", "LAN – Benedikt Lange"],
    ["g-ag-schuelerzeitung", "Deutsch", "BRA – Jana Brandt"],
  ] as const) {
    await page.goto(`/planung/unterricht?gruppe=${group}&neu=1`);
    await page.getByLabel("Fach").selectOption({ label: subject });
    await page.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: teacher });
    await page.getByLabel("Band", { exact: true }).selectOption({ label: `${bandName} (1 Std.)` });
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page).not.toHaveURL(/neu=/);
  }

  // Setzhilfe in der AG Robotik: der Lehrauftrag ist als Band offen und wird mit dem Deutsch-Lehrauftrag der Schülerzeitung gesetzt
  await page.goto("/planung/stundenplan?gruppe=g-ag-robotik");
  const panel = page.getByRole("article", { name: "Offene Stunden" });
  const open = panel.getByRole("link", { name: "Setzen: Informatik · LAN, 1 von 1 offen" });
  await expect(open).toContainText(`Band ${bandName}`);
  await expect(open).toContainText("AG Schülerzeitung Deutsch");
  await open.click();
  await expect(page).toHaveURL(/setzen=/);
  const setButton = page.getByRole("button", { name: /^Hier setzen: / }).first();
  const setSlot = (await setButton.getAttribute("aria-label"))!.replace("Hier setzen: ", "");
  await setButton.click();
  await expect(page).not.toHaveURL(/setzen=/);
  await expect(panel.getByText("Alle Lehraufträge sind im Stundenplan verplant.")).toBeVisible();
  const robotik = page.getByRole("table", { name: "Stundenplan AG Robotik" });
  const informatik = robotik.getByRole("link", { name: /^Informatik/ });
  await expect(informatik).toHaveCount(1);
  await expect(informatik).toContainText("Kopplung");
  await expect(informatik).toContainText("AG Schülerzeitung");
  await expect(informatik).toContainText("IF1"); // Fachraum je Teil
  // … und in der Schülerzeitung liegt Deutsch im selben Slot, ebenfalls als Kopplung
  await page.goto("/planung/stundenplan?gruppe=g-ag-schuelerzeitung");
  const zeitung = page.getByRole("table", { name: "Stundenplan AG Schülerzeitung" });
  const cellOf = (table: typeof zeitung, slot: string) => {
    const m = /^(Mo|Di|Mi|Do|Fr) (\d+)\. Stunde$/.exec(slot)!;
    return table.locator("tbody tr").nth(Number(m[2]) - 1).locator("td").nth(["Mo", "Di", "Mi", "Do", "Fr"].indexOf(m[1]!) + 1);
  };
  await expect(cellOf(zeitung, setSlot).getByRole("link", { name: /^Deutsch/ })).toContainText("Kopplung");
  await expect(page.getByRole("article", { name: "Offene Stunden" }).getByText("Alle Lehraufträge sind im Stundenplan verplant.")).toBeVisible();

  // Verschieben bewegt beide Teile
  await page.goto("/planung/stundenplan?gruppe=g-ag-robotik");
  await informatik.click();
  await expect(page.getByRole("heading", { name: "Kopplung bearbeiten · AG Robotik" })).toBeVisible();
  await page.getByRole("link", { name: "Verschieben oder tauschen" }).click();
  await expect(page.getByText("hier liegt die Stunde")).toBeVisible();
  const moveButton = page.getByRole("button", { name: /^Hierher verschieben: / }).first();
  const moveSlot = (await moveButton.getAttribute("aria-label"))!.replace("Hierher verschieben: ", "");
  expect(moveSlot).not.toBe(setSlot);
  await moveButton.click();
  await expect(page).not.toHaveURL(/verschieben=/);
  await expect(cellOf(robotik, moveSlot).getByRole("link", { name: /^Informatik/ })).toBeVisible();
  await page.goto("/planung/stundenplan?gruppe=g-ag-schuelerzeitung");
  await expect(cellOf(zeitung, moveSlot).getByRole("link", { name: /^Deutsch/ })).toBeVisible();
  await expect(cellOf(zeitung, setSlot).getByRole("link", { name: /^Deutsch/ })).toHaveCount(0);

  // aufräumen: Kopplung, Band und beide Lehraufträge weg
  await page.goto("/planung/stundenplan?gruppe=g-ag-robotik");
  await informatik.click();
  await page.getByRole("button", { name: "Kopplung löschen" }).click();
  await expect(robotik.getByRole("link", { name: /^Informatik/ })).toHaveCount(0);
  await page.goto("/planung/unterricht?ansicht=baender");
  await page.getByRole("link", { name: bandName }).click();
  await page.getByRole("button", { name: "Band löschen" }).click();
  await expect(page.getByRole("link", { name: bandName })).toHaveCount(0);
  for (const [group, subject] of [
    ["g-ag-robotik", "Informatik"],
    ["g-ag-schuelerzeitung", "Deutsch"],
  ] as const) {
    await page.goto(`/planung/unterricht?gruppe=${group}`);
    await page.getByRole("row").filter({ hasText: subject }).getByRole("link", { name: subject }).click();
    await page.getByRole("button", { name: "Lehrauftrag löschen" }).click();
    await expect(page).not.toHaveURL(/auftrag=/);
    await expect(page.getByRole("row").filter({ hasText: subject })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("GATE SP: Vertretung mit Fachtausch – „Mathematik statt Sport“ bei der Klasse, im Druck und auf dem Monitor", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // erste Sport-Stunde der 7b ohne Änderung in den nächsten Tagen suchen
  const lessons = page.getByRole("region", { name: /^Stunden am/ });
  let date = "";
  let label = "";
  const day = new Date();
  for (let i = 0; i < 14 && !label; i++, day.setDate(day.getDate() + 1)) {
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    await page.goto(`/planung/vertretungen?datum=${ymd(day)}&gruppe=g-7b`);
    const free = lessons.getByRole("form", { name: /· Sport · Klasse 7b$/ }).filter({ hasNot: page.getByRole("button", { name: "Aufheben" }) });
    if ((await free.count()) > 0) {
      date = ymd(day);
      label = (await free.first().getAttribute("aria-label"))!;
    }
  }
  expect(label, "Sport-Stunde der 7b in den nächsten zwei Wochen").not.toBe("");
  const form = lessons.getByRole("form", { name: label, exact: true });
  await form.getByLabel("Art").selectOption("substitute");
  const teacher = form.getByLabel("Vertretung durch");
  await teacher.selectOption((await teacher.locator('optgroup[label="Frei"] option').first().getAttribute("value"))!);
  await expect(form.getByLabel("Fach").locator("option:checked")).toHaveText("Sport (regulär)");
  await form.getByLabel("Fach").selectOption({ label: "Mathematik" });
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await page.goto(`/planung/vertretungen?datum=${date}&gruppe=g-7b`);
  await expect(lessons.getByText("→ Mathematik").first()).toBeVisible();
  await publishIfDraft(page);
  const all = page.getByRole("region", { name: /^Alle Änderungen am/ });
  await expect(all.getByText("Mathematik statt Sport")).toBeVisible();

  await page.goto("/druck/vertretungsplan");
  await expect(page.getByText("Mathematik statt Sport").first()).toBeVisible();
  await page.goto("/monitor/demo-foyer-lindenhof-2026");
  await expect(page.getByText("Mathematik (statt Sport)").first()).toBeVisible();

  // Schülerin der 7b
  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.goto("/stundenplan/vertretungen");
  await expect(page.getByText("Mathematik statt Sport").first()).toBeVisible();

  // aufräumen
  await logoutForSwitch(page);
  await login(page, "frank.schulte");
  await page.goto(`/planung/vertretungen?datum=${date}`);
  await page
    .getByRole("region", { name: /^Alle Änderungen am/ })
    .getByRole("row")
    .filter({ hasText: "Mathematik statt Sport" })
    .getByRole("button", { name: /^Aufheben/ })
    .click();
  await expect(page.getByText("Mathematik statt Sport")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("GATE SP: Sekretariat kommt nicht in die Planung (404), alte Verwaltungs-Lesezeichen leiten die Planung weiter", async ({ page }) => {
  await login(page, "sabine.kowalski");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Stundenplanung" })).toHaveCount(0);
  for (const path of ["/planung", "/planung/solver", "/planung/solver/vergleich", "/planung/vertretungen", runs.A ? new URL(runs.A).pathname : "/planung/solver/x"]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
  expect((await page.goto("/verwaltung/stundenplan/solver"))?.status()).toBe(404);

  await logoutForSwitch(page);
  await login(page, "frank.schulte");
  for (const [from, to] of [
    ["/verwaltung/stundenplan/solver", "/planung/solver"],
    ["/verwaltung/vertretungen?gruppe=g-7b", "/planung/vertretungen?gruppe=g-7b"],
    ["/verwaltung/unterricht/zeitwuensche", "/planung/zeitwuensche"],
  ]) {
    expect((await page.goto(from!))?.status(), from).toBe(200);
    expect(new URL(page.url()).pathname + new URL(page.url()).search, from).toBe(to);
  }
});

test("GATE SP: A11Y-Durchgang der Planungsseiten – hell und dunkel, Vergleich auf 360 px ohne Überlauf", async ({ page, browser }) => {
  test.setTimeout(240_000);
  expect(compareUrl, "Vergleich aus dem ersten Test").not.toBe("");
  await login(page, "frank.schulte");
  const paths = [
    "/planung",
    "/planung/stundenplan?gruppe=g-7b",
    "/planung/unterricht",
    "/planung/unterricht?ansicht=diagnose",
    "/planung/zeitwuensche",
    "/planung/solver",
    new URL(runs.A!).pathname,
    new URL(runs.C!).pathname,
    new URL(compareUrl).pathname + new URL(compareUrl).search,
    "/planung/vertretungen?gruppe=g-7b",
    "/planung/vertretungen/statistik",
    "/planung/aufsichten",
  ];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("load");
      await axe(page, `${path} (${scheme})`);
    }
  }

  // Vergleich auf schmalem Bildschirm: Tabellen scrollen in ihrem Rahmen, die Seite selbst nicht (isMobile: false, sonst zoomt Chrome)
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  await p.goto(compareUrl);
  await expect(p.getByRole("heading", { name: "Läufe vergleichen", level: 1 })).toBeVisible();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await p.screenshot({ path: ".data/shots/e2e/gate-sp-vergleich-360.png", fullPage: true });
  await narrow.close();
});

test("GATE SP: Aufräumen – Läufe des Szenarios löschen", async ({ page }) => {
  await login(page, "frank.schulte");
  for (const key of ["A", "B", "C"]) {
    const url = runs[key];
    if (!url) continue;
    await page.goto(url);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Lauf löschen" }).click();
    await expect(page).toHaveURL(/\/planung\/solver\?geloescht=1$/);
  }
});
