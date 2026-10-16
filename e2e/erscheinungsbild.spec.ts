import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

const SHOTS = ".data/shots/e2e";
const MONITOR = "/monitor/demo-foyer-lindenhof-2026";
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>';
// echtes, darstellbares PNG (SchulOS-Zeichen, 512 × 512)
const PNG = readFileSync("public/icon.png");

/** Bild ist sichtbar und tatsächlich geladen (nicht nur das <img>-Element). */
async function expectLoaded(page: Page, selector: string) {
  const img = page.locator(selector).first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
}

test.describe("Erscheinungsbild (Schullogo)", () => {
  test("Logo-Route: öffentlich, Typ fest, nosniff, Sandbox, Cache nach Version", async ({ request: anon }) => {
    const res = await anon.get("/api/schule/logo");
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-type"]).toBe("image/svg+xml");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toContain("sandbox");
    expect(h["content-security-policy"]).toContain("default-src 'none'");
    expect(h["cache-control"]).toBe("public, max-age=300");
    expect((await anon.get("/api/schule/logo?variante=../../etc")).status()).toBe(404);
    // die Adresse aus der Anmeldeseite trägt die Version → unveränderlich zwischenspeicherbar
    const login = await anon.get("/login");
    const src = /src="(\/api\/schule\/logo\?v=[0-9a-f]+)"/.exec(await login.text())?.[1];
    expect(src).toBeTruthy();
    expect((await anon.get(src!)).headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("SVG mit Skript abgelehnt, PNG angenommen und überall sichtbar, Entfernen → Rückfall", async ({ page, browser }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await login(page, "sabine.kowalski");
    await page.goto("/verwaltung/schule");
    const logo = page.getByRole("region", { name: "Logo", exact: true });
    await expect(logo).toContainText("SVG · 360 × 96"); // Demo-Logo aus dem Seed
    await page.screenshot({ path: `${SHOTS}/verwaltung-erscheinungsbild.png`, fullPage: true });

    // 1. SVG mit Skript → verständliche Ablehnung, altes Logo bleibt
    await logo.getByLabel("Logo-Datei", { exact: true }).setInputFiles({ name: "boese.svg", mimeType: "image/svg+xml", buffer: Buffer.from(EVIL_SVG) });
    await logo.getByRole("button", { name: "Logo ersetzen", exact: true }).click();
    await expect(logo.getByRole("alert")).toContainText("aus Sicherheitsgründen nicht angenommen");
    await expect(logo).toContainText("SVG · 360 × 96");

    // 2. PNG → angenommen
    await logo.getByLabel("Logo-Datei", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await logo.getByRole("button", { name: "Logo ersetzen", exact: true }).click();
    await expect(logo.getByRole("status")).toHaveText("Gespeichert.");
    await expect(logo).toContainText("PNG · 512 × 512");

    // 3. Shell (Seitenleiste), Druckkopf, Login, Monitor
    await page.goto("/");
    await expectLoaded(page, 'aside img[data-logo="logo"]');
    await page.goto("/druck/vertretungsplan");
    await expectLoaded(page, 'main header img[data-logo="logo"]');
    await page.goto("/druck/stundenplan");
    await expectLoaded(page, 'main header img[data-logo="logo"]');

    const anon = await (await browser.newContext()).newPage();
    const anonErrors = collectErrors(anon);
    await anon.goto("/login");
    await expectLoaded(anon, 'main img[data-logo="logo"]');
    await expect(anon.locator('link[rel="icon"][href^="/api/schule/logo?variante=symbol"]')).toHaveCount(1);
    await expect(anon.locator('link[rel="icon"][href="/icon.png"]')).toHaveCount(1);
    await anon.goto(MONITOR);
    await expect(anon.getByRole("heading", { name: "Vertretungsplan" })).toBeVisible();
    await expectLoaded(anon, 'header img[data-logo="symbol"]');

    // 4. alles entfernen → Rückfall: SchulOS-Zeichen und Schulname, statisches Favicon
    await page.goto("/verwaltung/schule");
    for (const title of ["Logo", "Logo für dunkle Darstellung", "Symbol"]) {
      const region = page.getByRole("region", { name: title, exact: true });
      await region.getByRole("button", { name: `${title} entfernen`, exact: true }).click();
      await expect(region.getByRole("button", { name: `${title} entfernen`, exact: true })).toHaveCount(0);
    }
    await page.goto("/");
    await expect(page.locator("aside img[data-logo]")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Seitenleiste" })).toContainText("Gesamtschule am Lindenhof");
    await page.goto("/druck/vertretungsplan");
    await expect(page.locator("img[data-logo]")).toHaveCount(0);
    await expect(page.locator("main header")).toContainText("Gesamtschule am Lindenhof");

    await anon.goto("/login");
    await expect(anon.locator("img[data-logo]")).toHaveCount(0);
    await expect(anon.getByRole("heading", { name: "SchulOS" })).toBeVisible();
    await expect(anon.locator("main")).toContainText("Gesamtschule am Lindenhof");
    await expect(anon.locator('link[rel="icon"]')).toHaveAttribute("href", "/icon.png");
    await anon.goto(MONITOR);
    await expect(anon.locator("img[data-logo]")).toHaveCount(0);
    expect((await anon.request.get("/api/schule/logo")).status()).toBe(404);

    expect(errors).toEqual([]);
    expect(anonErrors).toEqual([]);
  });
});
