import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP-03 (docs/STUNDENPLAN-UMBAU.md §2.3): eigener Bereich „Stundenplanung“ unter /planung statt Reiter in der Verwaltung.

test("SP-03: Stundenplanung (frank.schulte) erreicht den Bereich über die Navigation, alle Reiter", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Stundenplanung" }).click();
  await expect(page).toHaveURL("/planung");
  await expect(page.getByRole("heading", { name: "Stundenplanung", level: 1 })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Stundenplanung" });
  await expect(tabs.getByRole("link")).toHaveText(["Übersicht", "Stundenplan", "Unterrichtsverteilung", "Zeitwünsche", "Automatisch planen", "Vertretungen", "Aufsichten"]);
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
  await expect(tabs.getByRole("link")).toHaveText(["Übersicht", "Vertretungen", "Aufsichten"]);
  expect((await page.goto("/planung/stundenplan"))?.status()).toBe(404);
  expect((await page.goto("/planung/solver"))?.status()).toBe(404);
  expect((await page.goto("/planung/vertretungen"))?.status()).toBe(200);
});
