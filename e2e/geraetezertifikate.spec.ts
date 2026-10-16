import { expect, test } from "@playwright/test";
import { collectErrors, DEMO_PASSWORD, login } from "./helpers";

// P4-40b: Gerätezertifikate / Anmeldung von außen. Ohne Caddy simuliert der Test die Kennzeichen, die sonst nur Caddy setzt
// (X-SchulOS-Extern, X-SchulOS-Geraet). Die Schul-CA ist im E2E-Server nicht eingerichtet (SCHULOS_DEVICE_CERTS fehlt):
// Lehrkräfte kommen im Modus „alles“ ohne Zertifikat herein, Verwaltung/Admin nicht. Mit echter CA: CI-Job `stack`.

async function tryLogin(page: import("@playwright/test").Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Passwort").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

test("Verwaltung → System → Gerätezertifikate: Übersicht, CA nicht eingerichtet, Regeln speichern", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "admin");
  await page.goto("/verwaltung/system");
  await page.getByRole("article", { name: "Gerätezertifikate" }).getByRole("link", { name: "Verwalten" }).click();
  await expect(page).toHaveURL("/verwaltung/system/geraete");
  await expect(page.getByRole("heading", { name: "Gerätezertifikate", level: 1 })).toBeVisible();
  await expect(page.getByRole("article", { name: "Schul-CA" })).toContainText("Nicht eingerichtet");
  // ohne CA kein Ausstellen
  await expect(page.getByRole("form", { name: "Gerätezertifikat ausstellen" })).toHaveCount(0);
  await expect(page.getByText("Noch keine Gerätezertifikate")).toBeVisible();

  const rules = page.getByRole("article", { name: "Regeln für den Zugriff von außen" });
  await expect(rules).toContainText("auch ohne Gerätezertifikat");
  await expect(rules).toContainText("Verwaltung/Admin von außen gesperrt");
  const form = page.getByRole("form", { name: "Regeln für den Zugriff von außen" });
  await form.getByLabel("Lehrkräfte und Personal von außen").selectOption("an");
  await form.getByRole("button", { name: "Regeln speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Regeln gespeichert");
  await page.reload();
  await expect(rules).toContainText("nur mit Gerätezertifikat");
  // zurück auf die Vorgabe (andere Tests melden sich nicht von außen an, aber sauber bleiben)
  await form.getByLabel("Lehrkräfte und Personal von außen").selectOption("vorgabe");
  await form.getByRole("button", { name: "Regeln speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Regeln gespeichert");
  expect(errors).toEqual([]);
});

test("Lehrkraft sieht die Seite nicht", async ({ page }) => {
  await login(page, "jana.brandt");
  const res = await page.goto("/verwaltung/system/geraete");
  expect(res?.status()).toBe(404);
});

test("von außen (Modus „alles“): Hinweis vorab, Admin abgelehnt wie falsches Passwort, Lehrkraft ohne CA angemeldet", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-schulos-extern": "alles" } });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await page.goto("/login");
  await expect(page.getByRole("note").filter({ hasText: "außerhalb des Schulnetzes" })).toContainText("Gerätezertifikat der Schule");
  await tryLogin(page, "admin");
  await expect(page.getByText("Benutzername oder Passwort ist falsch.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await tryLogin(page, "jana.brandt");
  await expect(page).toHaveURL("/");
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
  await ctx.close();
});

test("im Schulnetz angemeldet, dann von außen: die Admin-Sitzung gilt dort nicht", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "admin");
  await ctx.setExtraHTTPHeaders({ "x-schulos-extern": "alles" });
  await page.goto("/verwaltung");
  await expect(page).toHaveURL(/\/login/);
  const api = await page.request.get("/api/gong/stream", { headers: { "x-schulos-extern": "alles" }, maxRedirects: 0 });
  expect(api.status()).toBe(403);
  // zurück im Schulnetz gilt sie wieder
  await ctx.setExtraHTTPHeaders({});
  await page.goto("/verwaltung");
  await expect(page).toHaveURL("/verwaltung");
  await ctx.close();
});

test("gefälschte Kennzeichen: „geraet“ ohne bzw. mit unbekanntem Fingerabdruck", async ({ browser }) => {
  const ohne = await browser.newContext({ extraHTTPHeaders: { "x-schulos-extern": "geraet" } });
  const res = await (await ohne.newPage()).goto("/login");
  expect(res?.status()).toBe(403);
  await ohne.close();

  // Fingerabdruck in richtiger Form, aber kein freigegebenes Zertifikat: Anmeldeseite ja, Anmeldung nein (auch nicht Eltern)
  const fremd = await browser.newContext({ extraHTTPHeaders: { "x-schulos-extern": "geraet", "x-schulos-geraet": "ab".repeat(32) } });
  const page = await fremd.newPage();
  await tryLogin(page, "jana.brandt");
  await expect(page.getByText("Benutzername oder Passwort ist falsch.")).toBeVisible();
  expect((await page.request.get("/api/health", { maxRedirects: 0 })).status()).toBe(403);
  await fremd.close();
});
