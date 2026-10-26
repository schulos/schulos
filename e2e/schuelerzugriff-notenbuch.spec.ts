import { expect, test, type Browser, type Page } from "@playwright/test";
import { collectErrors, confirmNotenbuchNotice, login } from "./helpers";

// GATE-5a (Schülerzugriff): Schüler:innen und Eltern haben keinen Zugriff auf Notenbücher – Ende zu Ende mit der Schülerin
// lea.schaefer und ihrer Mutter daniela.schaefer. Jede Notenbuch-URL (Übersicht, /notenbuch/<id>, /notenbuch/klasse/<id>),
// der CSV-Export und die Server Actions der Notentabelle samt Offline-Eingabe (mit der echten, öffentlich im Browser-Code
// stehenden Action-ID aufgerufen) weisen ab; keine Navigation, kein Widget, kein Kursraum-Link, kein Suchtreffer. Mit
// eingeschalteter Schüler-/Elternsicht (P5-14) nur die eigenen Noten – ohne Kommentare, Vorschläge, Mitschüler:innen und Links
// ins Notenbuch. Die Vitest-Suite `src/modules/notenbuch/schuelerzugriff.test.ts` prüft jede Funktion einzeln.
// Reihenfolge („schuelerzugriff-“ nach localeCompare): nach notenbuch/offline-notenbuch (die erwarten den Datenschutzhinweis
// P5-17 von jana.brandt beim ersten Öffnen – hier bestätigt jana ihn nur, falls er noch kommt) und vor schuljahreswechsel und
// zx-gate5a. Am Ende stehen beide Einstellungen wieder auf „aus“.

test.describe.configure({ mode: "serial" });

const FAMILY = ["lea.schaefer", "daniela.schaefer"] as const;
const LEA_SECTION = "Noten Lea Schäfer";
const DEVICE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const BOOK = "Klasse 7b – Deutsch";
const STUDENT_VIEW = "Noten für Schüler:innen sichtbar";
const PARENTS_VIEW = "Noten für Eltern sichtbar";

let bookPath = "";
let bookId = "";
/** Namen von Mitschüler:innen aus der Notentabelle der Lehrkraft */
let classmates: string[] = [];
/** Action-IDs aus dem Browser-Code der Notentabelle (öffentlich – ein Angreifer kennt sie auch) */
const actionIds = new Map<string, string>();
const ACTIONS = [
  "offlineActivateAction",
  "offlineShareAction",
  "offlineSyncAction",
  "offlineDeactivateAction",
  "setEntryAction",
];

async function asUser(browser: Browser, username: string): Promise<Page> {
  const p = await (await browser.newContext()).newPage();
  await login(p, username);
  return p;
}

async function setViews(browser: Browser, student: string, parents: string) {
  const admin = await asUser(browser, "admin");
  await admin.goto("/verwaltung/rechte");
  const region = () =>
    admin.getByRole("region", { name: "Einstellungen Notenbuch" });
  // die Auswahl speichert per Server Action im Hintergrund (optimistische Anzeige) – erst nach deren Antwort weiter, sonst
  // bricht das Neuladen die zweite Speicherung ab (Wackler im Einzellauf)
  for (const [label, value] of [
    [STUDENT_VIEW, student],
    [PARENTS_VIEW, parents],
  ] as const) {
    const select = region().getByLabel(label);
    if ((await select.inputValue()) === value) continue;
    const saved = admin.waitForResponse((r) => r.request().method() === "POST" && !!r.request().headers()["next-action"]);
    await select.selectOption(value);
    await saved;
    await expect(select).toHaveValue(value);
  }
  await admin.reload();
  await expect(region().getByLabel(STUDENT_VIEW)).toHaveValue(student);
  await expect(region().getByLabel(PARENTS_VIEW)).toHaveValue(parents);
  await admin.context().close();
}

/** Server Action direkt aufrufen (wie der Browser: POST mit `Next-Action`) – Ergebnis: Weiterleitung und Antworttext */
async function callAction(page: Page, name: string, args: unknown[]) {
  const id = actionIds.get(name)!;
  const res = await page.request.post(bookPath, {
    headers: {
      "Next-Action": id,
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: new URL(page.url()).origin,
    },
    data: JSON.stringify(args),
    maxRedirects: 0,
  });
  return {
    status: res.status(),
    redirect: res.headers()["x-action-redirect"] ?? "",
    body: await res.text(),
  };
}

/** Alle Zugangswege, die immer abweisen müssen – mit Sicht aus wie an */
async function expectNoNotenbuch(page: Page, who: string) {
  for (const path of [
    bookPath,
    `/notenbuch/klasse/g-7b`,
    `/notenbuch/klasse/g-7b?sj=sj-2026-27&hj=1`,
    "/notenbuch/gibt-es-nicht",
    "/notenbuch/klasse/gibt-es-nicht",
  ]) {
    expect((await page.goto(path))!.status(), `${who} ${path}`).toBe(404);
    await expect(page.locator("body"), `${who} ${path}`).not.toContainText(
      "Notentabelle",
    );
  }
  // CSV-Export: POST wie aus dem Formular → wie nicht vorhanden; GET exportiert ohnehin nie
  const csv = await page.request.post("/api/notenbuch/export", {
    form: {
      groupId: "g-7b",
      schoolYearId: "sj-2026-27",
      term: "1",
      encoding: "utf8",
    },
  });
  expect(csv.status(), who).toBe(404);
  expect(await csv.text(), who).not.toMatch(/Nachname|Klasse;/);
  expect((await page.request.get("/api/notenbuch/export")).status(), who).toBe(
    405,
  );
  // Server Actions der Notentabelle und der Offline-Eingabe: Weiterleitung, bevor irgendetwas läuft – kein Schlüsselanteil
  const calls: [string, unknown[]][] = [
    ["offlineActivateAction", [DEVICE, true]],
    ["offlineShareAction", [DEVICE]],
    ["offlineSyncAction", [bookId, DEVICE, []]],
    ["offlineDeactivateAction", [DEVICE]],
    [
      "setEntryAction",
      [{ columnId: "x", studentId: "u-lea.schaefer", value: "1" }],
    ],
  ];
  for (const [name, args] of calls) {
    const r = await callAction(page, name, args);
    expect(r.redirect, `${who} ${name} (Status ${r.status})`).toMatch(
      /^\/notenbuch(;|$)/,
    );
    expect(r.body, `${who} ${name}`).not.toMatch(/"share"|"version"|"results"/);
  }
  // Startseite: kein Widget; Suche: keine Notenbücher
  await page.goto("/");
  await expect(
    page.getByRole("article", { name: "Meine Notenbücher" }),
  ).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Wohin möchtest du/).fill("Deutsch");
  await expect(
    page.getByRole("option").first().or(page.getByText("Nichts gefunden.")),
  ).toBeVisible();
  await expect(page.getByText("Notenbücher", { exact: true }), who).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("option", { name: new RegExp(BOOK) }),
    who,
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
}

test.afterAll(async ({ browser }) => {
  // gemeinsame E2E-Datenbank: Einstellungen in jedem Fall zurück auf die Vorgabe
  await setViews(browser, "aus", "0");
});

test("Schülerzugriff: Vorbereitung – Buch, Mitschüler:innen und Action-IDs aus der Sicht der Lehrkraft", async ({
  page,
}) => {
  await login(page, "jana.brandt");
  await confirmNotenbuchNotice(page);
  if ((await page.getByRole("link", { name: BOOK }).count()) === 0) {
    // nur bei einem Einzellauf: das Buch aus notenbuch.spec fehlt
    const form = page.getByRole("form", { name: "Neues Notenbuch" });
    await form.getByLabel("Lerngruppe und Fach").selectOption({ label: BOOK });
    await form.getByLabel("Halbjahr").selectOption("1");
    await form.getByLabel("Skala").selectOption("noten6");
    await form.getByRole("button", { name: "Anlegen" }).click();
    await expect(form.getByRole("status")).toContainText("Notenbuch angelegt");
  }
  await page.getByRole("link", { name: BOOK }).first().click();
  await expect(page.getByRole("heading", { name: BOOK })).toBeVisible();
  bookPath = new URL(page.url()).pathname;
  bookId = decodeURIComponent(bookPath.split("/").pop()!);
  const names = await page
    .getByRole("table", { name: "Notentabelle" })
    .locator("tbody")
    .getByRole("rowheader")
    .allTextContents();
  classmates = names
    .map((n) => n.trim())
    .filter((n) => n && !/Lea Schäfer|Schäfer, Lea/.test(n))
    .slice(0, 5);
  expect(classmates.length).toBeGreaterThan(0);
  // alle Skripte der Seite mitschreiben (die Seiten-Chunks lädt Next nach – nicht als <script src> im HTML)
  const scripts = new Set<string>();
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.add(r.url());
  });
  await page.goto(bookPath);
  await expect(page.getByRole("heading", { name: BOOK })).toBeVisible();
  await page.waitForLoadState("networkidle");
  for (const src of scripts) {
    const js = await (await page.request.get(src)).text();
    for (const m of js.matchAll(
      /createServerReference\)\("([0-9a-f]+)"[^)]*?"(\w+Action)"\)/g,
    ))
      actionIds.set(m[2]!, m[1]!);
  }
  for (const name of ACTIONS)
    expect(actionIds.get(name), name).toMatch(/^[0-9a-f]{20,}$/);
});

test("Schülerzugriff: Rechteverwaltung bietet Notenbuch-Rechte für Schüler:innen und Eltern gar nicht an", async ({
  page,
}) => {
  await login(page, "admin");
  await page.goto("/verwaltung/rechte");
  for (const role of ["Schüler:in", "Eltern"]) {
    await expect(
      page.getByRole("checkbox", {
        name: new RegExp(`^Eigene Notenbücher führen.* für ${role}$`),
      }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel(
        new RegExp(
          `^Eigene Notenbücher führen.* für ${role}: nicht vergebbar$`,
        ),
      ),
    ).toHaveCount(1);
  }
  // Gegenprobe: für Lehrkräfte ist der Haken da (Vorgabe gesetzt)
  await expect(
    page.getByRole("checkbox", {
      name: /^Eigene Notenbücher führen.* für Lehrkraft$/,
    }),
  ).toBeChecked();
});

test("Schülerzugriff: Sicht aus – Schülerin und Mutter erreichen nichts vom Notenbuch", async ({
  browser,
}) => {
  for (const user of FAMILY) {
    const page = await asUser(browser, user);
    const errors = collectErrors(page);
    await expect(
      page.getByRole("link", { name: "Notenbuch", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Noten", exact: true }),
    ).toHaveCount(0);
    expect((await page.goto("/notenbuch"))!.status(), user).toBe(404);
    await expect(
      page.getByRole("form", { name: "Datenschutzhinweis zum Notenbuch" }),
    ).toHaveCount(0);
    await expectNoNotenbuch(page, user);
    if (user === "lea.schaefer") {
      // Kursraum der eigenen Klasse: keine Notenbuch-Karte
      await page.goto("/kurse/g-7b");
      await expect(
        page.getByRole("article", { name: "Notenbuch", exact: true }),
      ).toHaveCount(0);
    }
    expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
    await page.context().close();
  }
});

test("Schülerzugriff: Sicht an – nur die eigenen Noten lesend, sonst weiter nichts", async ({
  browser,
}) => {
  await setViews(browser, "teilnoten", "10");
  for (const user of FAMILY) {
    const page = await asUser(browser, user);
    const errors = collectErrors(page);
    await expect(
      page.getByRole("link", { name: "Notenbuch", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Noten", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Noten", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("form", { name: "Datenschutzhinweis zum Notenbuch" }),
    ).toHaveCount(0);
    const main = page.locator("main");
    // genau eine Person: Lea (auch bei der Mutter) – keine Mitschüler:innen, keine Lehrkräfte-Bereiche
    await expect(main.locator("section[aria-label^='Noten ']")).toHaveCount(1);
    await expect(main.getByRole("region", { name: LEA_SECTION })).toBeVisible();
    for (const name of classmates)
      await expect(main, `${user}: ${name}`).not.toContainText(name);
    for (const text of [
      "Vorschlag",
      "Kommentar",
      "Notenspiegel",
      "Gewicht",
      "Übergabeliste",
      "CSV",
      "Meine Notenbücher",
      "Notentabelle",
    ]) {
      await expect(main, `${user}: ${text}`).not.toContainText(text);
    }
    await expect(main.locator("a[href^='/notenbuch/']")).toHaveCount(0);
    await expect(main.locator("input, textarea, select")).toHaveCount(0);
    await expectNoNotenbuch(page, user);
    expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
    await page.context().close();
  }
  await setViews(browser, "aus", "0");
  const lea = await asUser(browser, "lea.schaefer");
  expect((await lea.goto("/notenbuch"))!.status()).toBe(404);
  await lea.context().close();
});
