// Bedrohungsmodell (docs/SICHERHEIT.md, B-54): fremde Daten über direkt eingegebene IDs (IDOR). Die IDs stammen von
// Berechtigten (Lea, 7b; Jana, Klassenleitung 7b) – abgerufen werden sie von einer Schülerin der 9a, einer Lehrkraft ohne
// 7b-Bezug bzw. ohne Anmeldung. Erwartet: 403/404 bzw. Umleitung, nie der Inhalt.
import { expect, test, type APIResponse, type Browser, type Page } from "@playwright/test";
import { login } from "./helpers";

/** Seite: 403/404 oder Umleitung weg von der Adresse – nie 200 mit Inhalt */
async function pageDenied(page: Page, url: string, secret?: string) {
  const res = await page.goto(url);
  const status = res?.status() ?? 0;
  const stayed = new URL(page.url()).pathname === new URL(url, "http://x").pathname;
  expect(status === 403 || status === 404 || !stayed, `${url}: Status ${status}, URL ${page.url()}`).toBe(true);
  if (secret) await expect(page.getByText(secret)).toHaveCount(0);
}

function apiDenied(res: APIResponse, url: string) {
  expect([401, 403, 404], `${url}: Status ${res.status()}`).toContain(res.status());
}

/** erste Person einer Rolle/Klasse über die Benutzerverwaltung (Sekretariat) – unabhängig von zufälligen Demo-Namen */
async function someone(browser: Browser, query: string): Promise<{ id: string; username: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "sabine.kowalski");
  await page.goto(`/verwaltung/benutzer?${query}`);
  const href = (await page.locator('main a[href^="/verwaltung/benutzer/"]:not([href$="/neu"]):not([href*="import"])').first().getAttribute("href"))!;
  await page.goto(href);
  const username = (await page.getByLabel("Benutzername").inputValue()).trim();
  await ctx.close();
  return { id: href.split("/").pop()!, username };
}

test.describe("Sicherheit · fremde Daten über IDs (IDOR)", () => {
  test("Schülerin der 9a und Lehrkraft ohne 7b-Bezug kommen nicht an Daten der 7b", async ({ page, browser }) => {
    // --- IDs von Berechtigten einsammeln
    const lea = await someone(browser, "q=lea.schaefer");
    const outsider = await someone(browser, "klasse=9a&role=schueler");

    const jana = await (await browser.newContext()).newPage();
    await login(jana, "jana.brandt");
    await jana.goto("/aufgaben");
    const taskHref = (await jana.getByRole("link", { name: /Erörterung Handyverbot/ }).first().getAttribute("href"))!;
    // privater Upload und Datei im Klassenordner der 7b
    const up = await jana.request.post("/api/dateien/upload", {
      multipart: { space: "personal", files: { name: "notenliste-7b.txt", mimeType: "text/plain", buffer: Buffer.from("geheim 7b") } },
    });
    expect(up.ok()).toBe(true);
    const privateFile = ((await up.json()) as { uploaded: { id: string }[] }).uploaded[0]!.id;
    // Klassentermin der 7b
    await jana.goto("/kalender/neu");
    await jana.getByLabel("Titel").fill("Nur 7b: Elterngespräch Raum 204");
    await jana.getByLabel("Kalender").selectOption({ label: "Klasse 7b" });
    await jana.getByRole("button", { name: "Anlegen" }).click();
    await expect(jana).toHaveURL(/\/kalender\/termin\//);
    const eventPath = new URL(jana.url()).pathname;
    await jana.context().close();

    // --- Schülerin der 9a
    await login(page, outsider.username);
    await pageDenied(page, taskHref, "Erörterung Handyverbot");
    await pageDenied(page, "/messenger/room-g-7b");
    await pageDenied(page, "/adressbuch/gruppe/g-7b");
    await pageDenied(page, `/adressbuch/person/${lea.id}`);
    await pageDenied(page, eventPath, "Elterngespräch Raum 204");
    await pageDenied(page, `/verwaltung/benutzer/${lea.id}`);
    await pageDenied(page, "/klassenbuch/klasse?gruppe=g-7b");
    for (const url of [`/api/dateien/${privateFile}`, "/api/kalender/ics?kal=group:g-7b"]) apiDenied(await page.request.get(url), url);
    // Exporte nur per POST (SEC-05)
    for (const url of [`/api/datenschutz/auskunft/${lea.id}`, "/api/klassenbuch/archiv/g-7b"]) apiDenied(await page.request.post(url), url);
    // eigener Zugriff funktioniert (sonst prüfte der Test nichts)
    expect((await page.request.get("/api/kalender/ics?kal=personal")).status()).toBe(200);
  });

  test("ohne Anmeldung: Seiten leiten zur Anmeldung, API antwortet 401", async ({ page }) => {
    for (const url of ["/aufgaben", "/messenger/room-g-7b", "/verwaltung/benutzer", "/dateien"]) {
      await page.goto(url);
      await expect(page).toHaveURL(/\/login/);
    }
    for (const url of ["/api/dateien/x", "/api/eigenexport", "/api/kalender/ics", "/api/datenschutz/auskunft/x", "/api/klassenbuch/archiv/x", "/api/gong/stream"]) {
      expect((await page.request.get(url)).status(), url).toBe(401);
    }
    expect((await page.request.post("/api/dateien/upload", { multipart: { space: "personal" } })).status()).toBe(401);
    for (const url of ["/api/eigenexport", "/api/datenschutz/auskunft/x", "/api/klassenbuch/archiv/x"]) expect((await page.request.post(url)).status(), url).toBe(401);
  });

  test("Lehrkraft ohne Datenschutz-Recht: keine Auskunft, kein Archiv, keine Benutzerverwaltung", async ({ page, browser }) => {
    const lea = await someone(browser, "q=lea.schaefer");
    await login(page, "jana.brandt");
    apiDenied(await page.request.post(`/api/datenschutz/auskunft/${lea.id}`), "auskunft");
    apiDenied(await page.request.post("/api/klassenbuch/archiv/g-7b"), "archiv");
    await pageDenied(page, `/verwaltung/benutzer/${lea.id}`);
  });
});
