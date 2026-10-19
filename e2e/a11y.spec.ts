import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./helpers";

// A11Y-01: Barrierefreiheit der Kernseiten je Rolle – axe-core (WCAG 2.0/2.1/2.2 A+AA und Best Practices, hell und dunkel)
// und Bedienung nur mit der Tastatur. Ziel: keine axe-Verstöße; begründete Ausnahmen stehen in ALLOWED (docs/BACKLOG.md
// A11Y-01h/i). Neue Kernseiten hier ergänzen.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/**
 * Begründete Ausnahmen (Regel → CSS-Selektor des betroffenen Knotens):
 * - A11Y-01h `region`: Radix legt geöffnete Menüs als Portal ans Ende von <body>, außerhalb der Landmarken. Das Menü hängt
 *   per aria-controls am Auslöser im Kopfbereich; „moderate“, bleibt offen.
 * - A11Y-01i `scrollable-region-focusable`: lange Menüs (Benutzermenü mit Demo-Konten) scrollen; die Einträge sind mit den
 *   Pfeiltasten erreichbar (Radix „roving tabindex“, Fokus scrollt mit) – axe zählt Einträge mit tabindex=-1 nicht mit.
 */
const ALLOWED: { rule: string; target: RegExp }[] = [
  { rule: "region", target: /data-radix-popper-content-wrapper/ },
  { rule: "scrollable-region-focusable", target: /^#radix-/ },
];

async function axe(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = r.violations.flatMap((v) =>
    v.nodes
      .map((n) => ({ rule: v.id, impact: v.impact, target: n.target.join(" "), summary: n.failureSummary?.split("\n").slice(1, 2).join(" ").trim() }))
      .filter((n) => !ALLOWED.some((a) => a.rule === n.rule && a.target.test(n.target))),
  );
  expect(found, `axe-Befunde auf ${where}`).toEqual([]);
}

const CORE: { user: string; label: string; paths: string[] }[] = [
  { user: "lea.schaefer", label: "Schülerin", paths: ["/", "/stundenplan", "/stundenplan/vertretungen", "/messenger", "/dateien", "/kurswahl", "/aufgaben", "/kalender", "/zwei-faktor", "/konto/sitzungen", "/konto/app"] },
  { user: "jana.brandt", label: "Lehrkraft", paths: ["/", "/stundenplan", "/klassenbuch", "/notenbuch", "/messenger", "/dateien", "/stundenplan/abwesenheit", "/zwei-faktor", "/apps"] },
  { user: "daniela.schaefer", label: "Eltern", paths: ["/", "/stundenplan", "/kurswahl", "/messenger", "/abwesenheiten"] },
  { user: "sabine.kowalski", label: "Sekretariat", paths: ["/", "/verwaltung", "/verwaltung/benutzer", "/verwaltung/gruppen", "/kurswahl"] },
  { user: "frank.schulte", label: "Stundenplanung", paths: ["/planung", "/planung/vertretungen"] },
  { user: "admin", label: "Admin", paths: ["/verwaltung", "/verwaltung/rechte", "/verwaltung/system", "/verwaltung/schule"] },
];

async function open(page: Page, path: string) {
  // Notenbuch: der Datenschutzhinweis (P5-17) wird bewusst nicht bestätigt – geprüft wird die Hinweisseite, und
  // notenbuch.spec.ts erwartet ihn beim ersten Öffnen
  await page.goto(path);
  // Seiten mit nachgeladenen Teilen (Gong-Zähler, Live-Strom) kurz zur Ruhe kommen lassen
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
}

test("A11Y-01: öffentliche Seiten ohne axe-Befund (hell und dunkel)", async ({ page }) => {
  test.setTimeout(120_000);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ["/login", "/barrierefreiheit", "/datenschutzhinweise", "/impressum", "/passwort-vergessen"]) {
      await open(page, path);
      await axe(page, `${path} (${scheme})`);
    }
  }
});

for (const { user, label, paths } of CORE) {
  test(`A11Y-01: Kernseiten ${label} ohne axe-Befund – auch dunkel und mit offenem Menü/Gong/Palette`, async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, user);
    for (const path of paths) {
      await open(page, path);
      await axe(page, `${user} ${path}`);
    }
    // dunkle Darstellung: Startseite (bzw. erste Seite) und eine Fachseite
    await page.emulateMedia({ colorScheme: "dark" });
    for (const path of paths.slice(0, 2)) {
      await open(page, path);
      await axe(page, `${user} ${path} (dunkel)`);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "Profilmenü öffnen" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await axe(page, `${user} Benutzermenü`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Gong –/ }).click();
    await expect(page.getByRole("dialog", { name: "Gong" })).toBeVisible();
    await axe(page, `${user} Gong`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Kommandopalette" })).toBeVisible();
    await axe(page, `${user} Kommandopalette`);
  });
}

test("A11Y-01: Kernseiten mobil ohne axe-Befund @mobile", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "lea.schaefer");
  for (const path of ["/", "/stundenplan", "/messenger", "/dateien"]) {
    await open(page, path);
    await axe(page, `mobil ${path}`);
  }
});

// ---------------------------------------------------------------- Tastatur

/** Tab drücken, bis `target` den Fokus hat (höchstens `max` Mal) – schlägt fehl, wenn es per Tastatur nicht erreichbar ist. */
async function tabTo(page: Page, target: Locator, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
  }
  throw new Error(`nicht per Tab erreichbar: ${target.toString()}`);
}

/** Hat das fokussierte Element einen sichtbaren Fokusrahmen (Umriss oder Ring)? */
async function focusVisible(page: Page): Promise<{ ok: boolean; what: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: true, what: "body" };
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const ring = cs.boxShadow !== "none" && cs.boxShadow !== "";
    const what = `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}`;
    return { ok: outline || ring, what };
  });
}

test("A11Y-01: Anmelden nur mit der Tastatur", async ({ page }) => {
  await page.goto("/login");
  await tabTo(page, page.getByLabel("Benutzername"));
  await page.keyboard.type("lea.schaefer");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Passwort")).toBeFocused();
  await page.keyboard.type("schulos");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");
  // der Link zur Erklärung zur Barrierefreiheit ist auf der Anmeldeseite per Tastatur erreichbar (A11Y-02)
  await page.context().clearCookies();
  await page.goto("/login");
  await tabTo(page, page.getByRole("link", { name: "Barrierefreiheit" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/barrierefreiheit");
});

test("A11Y-01: Sprungmarke, Navigation, Benutzermenü, Gong und Palette mit der Tastatur", async ({ page }) => {
  await login(page, "jana.brandt");
  await page.goto("/");
  // erster Tab: „Zum Inhalt springen“, sichtbar; Enter setzt den Fokus in den Inhalt
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Zum Inhalt springen" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#inhalt")).toBeFocused();

  // Seitenleiste: Stundenplan per Tab + Enter (von oben, die Seitenleiste steht vor dem Inhalt)
  await page.goto("/");
  await tabTo(page, page.getByRole("navigation").getByRole("link", { name: "Stundenplan", exact: true }).first());
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/stundenplan");

  // Benutzermenü: Enter öffnet, Pfeiltasten bis „Dunkel“, Enter wählt, Escape schließt – Fokus zurück am Auslöser
  const trigger = page.getByRole("button", { name: "Profilmenü öffnen" });
  await tabTo(page, trigger);
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const dark = menu.getByRole("menuitemradio", { name: "Dunkel" });
  // Enter öffnet mit Fokus auf dem ersten Eintrag („Hell“), ein Pfeil nach unten führt zu „Dunkel“
  await expect(menu.getByRole("menuitemradio", { name: "Hell" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(dark).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(dark).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Gong: Enter öffnet den Dialog, Escape schließt ihn, Fokus zurück
  const gong = page.getByRole("button", { name: /^Gong –/ });
  // steht direkt vor dem Benutzermenü
  await page.keyboard.press("Shift+Tab");
  await expect(gong).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Gong" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Gong" })).toHaveCount(0);
  await expect(gong).toBeFocused();

  // Kommandopalette: Strg+K, Suchbegriff, Enter navigiert
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Kommandopalette" });
  await expect(palette).toBeVisible();
  await page.keyboard.type("Klassenbuch");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/klassenbuch/);
});

test("A11Y-01: sichtbarer Fokus auf den ersten Tab-Stopps der Kernseiten je Rolle", async ({ page }) => {
  test.setTimeout(180_000);
  const missing: string[] = [];
  for (const { user, paths } of CORE) {
    await page.context().clearCookies();
    await login(page, user);
    for (const path of paths) {
      await open(page, path);
      await page.locator("body").focus();
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Tab");
        const f = await focusVisible(page);
        if (!f.ok) missing.push(`${user} ${path}: ${f.what}`);
      }
    }
  }
  expect([...new Set(missing)]).toEqual([]);
});
