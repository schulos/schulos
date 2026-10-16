import { expect, test, type Page } from "@playwright/test";
import { collectErrors, confirmNotenbuchNotice, login } from "./helpers";

// P4-73: PWA ohne Push – Manifest, Service Worker registriert, nur statische Programmdateien im Cache (nie Notenbuch, API,
// Seiten), offline der Hinweis „Keine Verbindung“, Abmelden leert die Caches; Installationshinweis unter /konto/app.

/** Alle zwischengespeicherten Adressen (Pfad) aller Caches dieser Seite. */
async function cachedPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(new URL(r.url).pathname);
    return out;
  });
}

/** Warten, bis der Service Worker die Seite steuert (beim ersten Besuch erst nach clients.claim). */
async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Wettlauf: wurde der Worker erst aktiv, nachdem die Navigation dieser Seite schon unterwegs war, erfasst clients.claim sie
  // nicht immer (unter Last im vollen Lauf beobachtet) – dann steuert er erst den nächsten Seitenaufruf
  const isControlled = () => page.evaluate(() => navigator.serviceWorker.controller !== null);
  if (!(await expect.poll(isControlled, { timeout: 3000 }).toBe(true).then(() => true, () => false))) await page.reload();
  await expect.poll(isControlled).toBe(true);
}

test("P4-73: Manifest und Service Worker ohne Anmeldung abrufbar, ohne Personendaten", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.status()).toBe(200);
  const manifest = await m.json();
  expect(manifest).toMatchObject({ short_name: "SchulOS", start_url: "/", display: "standalone", lang: "de" });
  expect(manifest.name).toContain("SchulOS");
  expect(manifest.icons.some((i: { src: string }) => i.src === "/icon.png")).toBe(true);
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toContain("javascript");
  expect(sw.headers()["cache-control"]).toContain("no-cache");
  const src = await sw.text();
  expect(src).toContain('"/notenbuch"');
  expect(src).toContain('"/api/notenbuch"');
});

test("P4-73: Service Worker registriert; Notenbuch, Seiten und API nie im Cache; offline Hinweis; Abmelden leert die Caches", async ({ page, context }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await controlled(page);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toMatch(/\/$/);

  // Notenbuch und weitere Seiten unter Kontrolle des Service Workers aufrufen
  await confirmNotenbuchNotice(page);
  const nb = await page.goto("/notenbuch");
  expect(nb!.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: "Meine Notenbücher" })).toBeVisible();
  await page.goto("/stundenplan");
  await page.goto("/messenger");

  const paths = await cachedPaths(page);
  // es wird gecacht – aber nur statische Programmdateien
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.filter((p) => !p.startsWith("/_next/static/") && p !== "/icon.png" && p !== "/favicon.ico")).toEqual([]);
  expect(paths.filter((p) => p.startsWith("/notenbuch") || p.startsWith("/api/"))).toEqual([]);
  expect(await page.evaluate(async () => (await caches.keys()).every((k) => k.startsWith("schulos-static-")))).toBe(true);

  // offline: Seiten zeigen den festen Hinweis (ohne Inhalte), das Notenbuch fasst der Service Worker nicht an
  await context.setOffline(true);
  await page.goto("/stundenplan");
  await expect(page.getByRole("heading", { name: "Keine Verbindung" })).toBeVisible();
  await expect(page.getByText("Inhalte werden auf diesem Gerät nicht gespeichert")).toBeVisible();
  await expect(page.getByRole("link", { name: "Erneut versuchen" })).toBeVisible();
  await expect(page.getByText("Mein Stundenplan")).toHaveCount(0);
  await expect(page.goto("/notenbuch")).rejects.toThrow();
  await context.setOffline(false);
  await page.goto("/");

  // Abmelden über das Benutzermenü leert alle SchulOS-Caches
  await page.getByRole("button", { name: "Profilmenü öffnen" }).click();
  await page.getByRole("menuitem", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("schulos-")).length)).toBe(0);
  // erwartet: der Offline-Hinweis kommt mit 503, der Notenbuch-Aufruf scheitert am Netz
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::|status of 503/i.test(e))).toEqual([]);
});

test("P4-73: Installationshinweis im Benutzermenü", async ({ page }) => {
  await login(page, "lea.schaefer");
  await page.getByRole("button", { name: "Profilmenü öffnen" }).click();
  await page.getByRole("menuitem", { name: "Als App installieren" }).click();
  await expect(page).toHaveURL("/konto/app");
  await expect(page.getByRole("heading", { name: "Als App installieren" })).toBeVisible();
  await expect(page.getByText("Zum Home-Bildschirm")).toBeVisible();
  await expect(page.getByText("Keine Inhalte:")).toBeVisible();
});
