import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

const SHOTS = ".data/shots/e2e";

test.describe("Anmeldung", () => {
  test("ohne Login landet man auf /login (inkl. Rücksprung)", async ({ page }) => {
    await page.goto("/verwaltung");
    await expect(page).toHaveURL(/\/login\?next=%2Fverwaltung/);
    await expect(page.getByRole("heading", { name: "SchulOS" })).toBeVisible();
  });

  test("falsches Passwort zeigt eine Fehlermeldung", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Benutzername").fill("jana.brandt");
    await page.getByLabel("Passwort").fill("falsch123");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Benutzername oder Passwort ist falsch.");
  });

  test("Demo-Instanz zeigt dauerhaft das Demo-Band (Login und Shell)", async ({ page }) => {
    const band = page.getByRole("note").filter({ hasText: "DEMO – keine echten Daten eingeben" });
    await page.goto("/login");
    await expect(band).toBeVisible();
    await login(page, "lea.schaefer");
    await expect(band).toBeVisible();
  });

  test("Login und Logout funktionieren", async ({ page }) => {
    await login(page, "jana.brandt");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Jana Brandt");
    await page.getByRole("button", { name: /Jana Brandt/ }).click();
    await page.getByRole("menuitem", { name: "Abmelden" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Rollen", () => {
  for (const [username, name] of [
    ["lea.schaefer", "Lea"],
    ["jana.brandt", "Jana Brandt"],
    ["petra.lindner", "Petra Lindner"],
    ["sabine.kowalski", "Sabine"],
    ["admin", "Admin"],
  ] as const) {
    test(`${username} sieht die Shell ohne Browser-Fehler`, async ({ page }) => {
      const errors = collectErrors(page);
      await login(page, username);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
      await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/heute-${username}.png` });
      expect(errors).toEqual([]);
    });
  }

  test("Verwaltung nur für Berechtigte", async ({ page }) => {
    await login(page, "jana.brandt");
    await expect(page.getByRole("link", { name: "Verwaltung" })).toHaveCount(0);
    const res = await page.goto("/verwaltung");
    expect(res?.status()).toBe(404);

    await page.context().clearCookies();
    await login(page, "sabine.kowalski");
    await page.getByRole("link", { name: "Verwaltung" }).click();
    await expect(page.getByRole("heading", { name: "Gesamtschule am Lindenhof" })).toBeVisible();
  });
});

test.describe("Shell", () => {
  test("Kommandopalette navigiert und schaltet das Theme", async ({ page }) => {
    await login(page, "petra.lindner");
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Wohin möchtest du/).fill("verw");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/verwaltung");

    await page.getByRole("button", { name: /Suchen oder Befehl/ }).click();
    await page.getByPlaceholder(/Wohin möchtest du/).fill("dunkel");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("Demo-Schnell-Login wechselt die Ansicht", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /Lea Schäfer/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Lea");

    await page.getByRole("button", { name: /Profilmenü öffnen/ }).click();
    await page.getByRole("menuitem", { name: /Jana Brandt/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Jana Brandt");
  });
});

test("@mobile Bottom-Bar statt Sidebar", async ({ page }) => {
  await login(page, "lea.schaefer");
  await expect(page.getByRole("navigation", { name: "Navigation", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })).toBeHidden();
  const bar = page.getByRole("navigation", { name: "Navigation", exact: true });
  await expect(bar.getByRole("link")).toHaveText([/Heute/, /Stundenplan/, /Aufgaben/, /Messenger/, /Mehr/]);
  await page.goto("/");
  await page.screenshot({ path: `${SHOTS}/heute-mobile.png` });
});

test.describe("Heute", () => {
  test("Eltern sehen ihr Kind, Lehrkraft ihre Gruppen, Verwaltung den Überblick", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /Eltern von Lea/ }).click();
    await expect(page.locator('[data-widget="heute.kinder"]')).toContainText("Lea Schäfer");
    await expect(page.locator('[data-widget="heute.kinder"]')).toContainText("Klasse 7b");

    await page.context().clearCookies();
    await login(page, "jana.brandt");
    await expect(page.locator('[data-widget="heute.gruppen"]')).toContainText("Klasse 7b");
    await expect(page.locator('[data-widget="verwaltung.ueberblick"]')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/heute-widgets-lehrkraft.png` });

    await page.context().clearCookies();
    await login(page, "petra.lindner");
    await expect(page.locator('[data-widget="verwaltung.ueberblick"]')).toContainText("Schüler:innen");
    await page.screenshot({ path: `${SHOTS}/heute-widgets-schulleitung.png` });
  });
});

test.describe("Globale Suche", () => {
  test("findet Personen per Kürzel und springt zum Profil", async ({ page }) => {
    const errors = collectErrors(page);
    await login(page, "lea.schaefer");
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Wohin möchtest du/).fill("OKA");
    const hit = page.getByRole("option", { name: /Daniel Okafor/ });
    await expect(hit).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/suche.png` });
    await hit.click();
    await expect(page).toHaveURL("/adressbuch/person/u-daniel.okafor");
    await expect(page.getByRole("heading", { name: "Daniel Okafor" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("respektiert Sichtbarkeit: Schülerin findet keine fremde Klasse", async ({ page }) => {
    await login(page, "lea.schaefer");
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Wohin möchtest du/).fill("Klasse 9a");
    await expect(page.getByText("Nichts gefunden.")).toBeVisible();
  });
});

// Eigene Prüfung OHNE Mobil-Emulation: mit isMobile zoomt Chrome bei überbreitem Inhalt heraus
// und innerWidth wächst mit – dann fällt der Fehler nicht auf.
test("@mobile nichts ragt auf 360 px über den Rand", async ({ browser }) => {
  // isMobile ausdrücklich aus – sonst erbt der Kontext die Pixel-7-Emulation des Projekts
  const page = await (await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })).newPage();
  await login(page, "lea.schaefer");
  for (const path of ["/", "/aufgaben", "/messenger", "/kalender?ansicht=agenda", "/dateien", "/news", "/adressbuch"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const sticking = await page.evaluate(() => {
      const scrolls = (el: Element) => {
        for (let p = el.parentElement; p && p.tagName !== "BODY"; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden") return true;
        }
        return false;
      };
      return [...document.querySelectorAll("main *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !scrolls(el))
        .slice(0, 3)
        .map((el) => el.outerHTML.slice(0, 120));
    });
    expect(sticking, `Elemente ragen über den Rand auf ${path}`).toEqual([]);
  }
  await page.context().close();
});
