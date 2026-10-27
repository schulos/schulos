import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// SP-03 (docs/STUNDENPLAN-UMBAU.md §2.3): eigener Bereich „Stundenplanung“ unter /planung statt Reiter in der Verwaltung.

test("SP-03: Stundenplanung (frank.schulte) erreicht den Bereich über die Navigation, alle Reiter", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Stundenplanung" }).click();
  await expect(page).toHaveURL("/planung");
  await expect(page.getByRole("heading", { name: "Stundenplanung", level: 1 })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Stundenplanung" });
  await expect(tabs.getByRole("link")).toHaveText(["Übersicht", "Stundenplan", "Unterrichtsverteilung", "Zeitwünsche", "Automatisch planen", "Versionen", "Fachbedarf", "Vertretungen", "Aufsichten"]);
  await expect(tabs.getByRole("link", { name: "Übersicht" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Automatisch planen" }).click();
  await expect(page).toHaveURL("/planung/solver");
  await expect(page.getByRole("heading", { name: "Automatisch planen", level: 1 })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Automatisch planen" })).toHaveAttribute("aria-current", "page");
  // Kein Verwaltungszugang nötig – und keiner vorhanden
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Verwaltung" })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect((await page.goto("/verwaltung"))?.status()).toBe(404);
});

test("SP-03: alte Verwaltungspfade leiten auf /planung weiter, Query bleibt erhalten", async ({ page }) => {
  await login(page, "frank.schulte");
  const cases: [string, string][] = [
    ["/verwaltung/stundenplan?gruppe=g-7b", "/planung/stundenplan?gruppe=g-7b"],
    ["/verwaltung/stundenplan/solver", "/planung/solver"],
    ["/verwaltung/unterricht?ansicht=diagnose", "/planung/unterricht?ansicht=diagnose"],
    ["/verwaltung/unterricht/zeitwuensche?art=teacher", "/planung/zeitwuensche?art=teacher"],
    ["/verwaltung/vertretungen/statistik", "/planung/vertretungen/statistik"],
    ["/verwaltung/aufsichten", "/planung/aufsichten"],
  ];
  for (const [from, to] of cases) {
    const res = await page.goto(from);
    expect(res?.status(), from).toBe(200);
    expect(new URL(page.url()).pathname + new URL(page.url()).search, from).toBe(to);
  }
  // 307 (vorläufig, Methode bleibt), die Weiterleitung selbst bleibt dauerhaft bestehen
  const raw = await page.request.get("/verwaltung/vertretungen?datum=2026-01-05", { maxRedirects: 0 });
  expect(raw.status()).toBe(307);
  expect(raw.headers()["location"]).toBe("/planung/vertretungen?datum=2026-01-05");
});

test("SP-03: Sekretariat plant nicht mehr – kein Bereich, keine Reiter in der Verwaltung", async ({ page }) => {
  await login(page, "sabine.kowalski");
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Stundenplanung" })).toHaveCount(0);
  for (const path of ["/planung", "/planung/stundenplan", "/planung/vertretungen", "/planung/aufsichten"]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
  // alte Lesezeichen landen ebenfalls auf 404 statt in der Verwaltung
  expect((await page.goto("/verwaltung/vertretungen"))?.status()).toBe(404);
  await page.goto("/verwaltung");
  const tabs = page.getByRole("navigation", { name: "Verwaltung" });
  await expect(tabs.getByRole("link", { name: "Stammdaten" })).toBeVisible();
  for (const name of ["Stundenplan", "Unterrichtsverteilung", "Vertretungen", "Aufsichten"]) {
    await expect(tabs.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
});

test("SP-03: Schulleitung (nur Vertretungen planen) sieht Vertretungen und Aufsichten, nicht die Jahresplanung", async ({ page }) => {
  await login(page, "petra.lindner");
  await page.goto("/planung");
  const tabs = page.getByRole("navigation", { name: "Stundenplanung" });
  // SP2-12: dazu „Fachbedarf einsehen“ (nur Summen je Fach)
  await expect(tabs.getByRole("link")).toHaveText(["Übersicht", "Fachbedarf", "Vertretungen", "Aufsichten"]);
  expect((await page.goto("/planung/stundenplan"))?.status()).toBe(404);
  expect((await page.goto("/planung/solver"))?.status()).toBe(404);
  expect((await page.goto("/planung/versionen"))?.status()).toBe(404);
  expect((await page.goto("/planung/vertretungen"))?.status()).toBe(200);
});

// SP-04: Übersicht mit Kennzahlen je Recht, Einstieg aus der Verwaltungs-Übersicht

test("SP-04: Übersicht zeigt Jahresplanung und Tagesgeschäft als Kacheln mit Links", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung");
  await expect(page.getByTestId("planungsjahr")).toContainText("Schuljahr");
  const jahr = page.getByRole("region", { name: "Jahresplanung" });
  const tag = page.getByRole("region", { name: "Tagesgeschäft" });
  for (const title of ["Offene Lehraufträge", "Diagnose", "Zeitwünsche"]) await expect(jahr.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await expect(jahr.locator("[data-kachel=solver]")).toBeVisible();
  for (const title of ["Vertretungsbedarf", "Unveröffentlichte Entwürfe", "Unbesetzte Aufsichten", "Raumsperren heute"]) {
    await expect(tag.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  }
  await jahr.getByRole("link", { name: /Diagnose/ }).click();
  await expect(page).toHaveURL("/planung/unterricht?ansicht=diagnose");
  expect(errors).toEqual([]);
});

test("SP-04: Schulleitung sieht nur das Tagesgeschäft und den Einstieg in der Verwaltung", async ({ page }) => {
  await login(page, "petra.lindner");
  await page.goto("/planung");
  await expect(page.getByRole("region", { name: "Tagesgeschäft" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Jahresplanung" })).toHaveCount(0);
  await page.goto("/verwaltung");
  // Schulleitung hat ein Planungsrecht (Vertretungen) → Einstieg sichtbar
  await page.getByRole("region", { name: "Kennzahlen" }).getByRole("link", { name: /Stundenplanung/ }).click();
  await expect(page).toHaveURL("/planung");
});

test("SP-04: Sekretariat ohne Planungsrecht bekommt keine Kachel „Stundenplanung“ in der Verwaltung", async ({ page }) => {
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung");
  await expect(page.getByRole("region", { name: "Kennzahlen" }).getByRole("link", { name: /Stundenplanung/ })).toHaveCount(0);
});

// SP-05: Rechte- statt Rollen-Gates im Stundenplan-Umfeld, Kurswahl lesend für die Stundenplanung

test("SP-05: Personal und Beratung sehen Wochenpläne und Räume, Schüler:innen keine Räume", async ({ page }) => {
  for (const user of ["klaus.berger", "nina.ostermann"]) {
    await login(page, user);
    await page.goto("/stundenplan");
    await expect(page.getByRole("form", { name: "Plan wählen" }), user).toBeVisible();
    expect((await page.goto("/stundenplan?gruppe=g-7b"))?.status(), user).toBe(200);
    expect((await page.goto("/stundenplan/raeume?ansicht=belegung"))?.status(), user).toBe(200);
    await expect(page.getByRole("heading", { name: "Räume", level: 1 })).toBeVisible();
    // Klassenbuch bleibt Lehrkräften und Verwaltung vorbehalten (Schülerdaten)
    expect((await page.goto("/klassenbuch"))?.status(), user).toBe(404);
    await logoutForSwitch(page);
  }
  await login(page, "lea.schaefer");
  expect((await page.goto("/stundenplan/raeume"))?.status()).toBe(404);
});

test("SP-05: Stundenplanung sieht die Kurswahlen lesend – ohne „Wahlverfahren anlegen“", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Kurswahlen" }).click();
  await expect(page).toHaveURL("/kurswahl");
  await expect(page.getByRole("heading", { name: "Kurswahlen", level: 1 })).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "Nur lesen" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Wahlverfahren anlegen" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
