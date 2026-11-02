import { rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// BM-02/BM-04: /api/health/details (nur Schulnetz bzw. mit Token) und die Karte „Betrieb“ in Verwaltung → System.
// Der E2E-Server steht ohne Reverse-Proxy: ohne X-Forwarded-For gilt eine Anfrage als Schulnetz, mit fremder Adresse als außen.
const tokenFile = path.join(process.cwd(), ".data", "config", "health-token");

test("Betriebsstatus: Schulnetz ja, fremde Adresse nein, von außen (Kennzeichen) gesperrt, Token-Betrieb", async ({ page, request }) => {
  // Vorgabe: Schulnetz → Kennzahlen ohne Personenbezug
  const res = await request.get("/api/health/details");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const report = await res.json();
  expect(report).toMatchObject({ version: 1, database: { ok: true }, backup: { paired: false } });
  expect(["ok", "warn", "error"]).toContain(report.level);
  expect(JSON.stringify(report)).not.toMatch(/@|sabine|jana|admin/i);
  // schlanke Liveness-Antwort unverändert
  expect(await (await request.get("/api/health")).json()).toEqual({ ok: true, db: "up" });

  // fremde Adresse (Caddy ersetzt X-Forwarded-For durch die ermittelte Adresse) → wie nicht vorhanden
  expect((await request.get("/api/health/details", { headers: { "x-forwarded-for": "8.8.8.8" } })).status()).toBe(404);
  // von außen (Kennzeichen von Caddy) sperrt schon der Proxy der App
  expect((await request.get("/api/health/details", { headers: { "x-schulos-extern": "1" } })).status()).toBe(403);
  expect((await request.get("/api/health/details", { headers: { "x-schulos-extern": "alles" } })).status()).toBe(404);

  // Admin stellt auf Token um
  await login(page, "admin");
  await page.goto("/verwaltung/system");
  await expect(page.getByRole("article", { name: "Betrieb" })).toBeVisible();
  const form = page.getByRole("form", { name: "Betriebsstatus einstellen" });
  await form.getByLabel(/Betriebsstatus für Überwachung/).selectOption("token");
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText(/Gespeichert: Betriebsstatus nur mit Token/)).toBeVisible();
  await page.getByRole("button", { name: "Neues Token erzeugen" }).click();
  const text = await page.getByText(/Neues Token \(jetzt notieren/).textContent();
  const token = /: (\S+)$/.exec(text ?? "")?.[1];
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  try {
    expect((await request.get("/api/health/details")).status()).toBe(404);
    expect((await request.get("/api/health/details", { headers: { authorization: "Bearer falsch" } })).status()).toBe(404);
    const ok = await request.get("/api/health/details", { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).version).toBe(1);
  } finally {
    // zurück auf die Vorgabe, damit andere Tests (und der Server) unverändert laufen
    await form.getByLabel(/Betriebsstatus für Überwachung/).selectOption("schulnetz");
    await form.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByText(/Gespeichert: Betriebsstatus nur aus dem Schulnetz/)).toBeVisible();
    rmSync(tokenFile, { force: true });
  }
  expect((await request.get("/api/health/details")).status()).toBe(200);
});

test("Karte „Betrieb“ in Verwaltung → System zeigt Stufe und Befunde", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/verwaltung/system");
  const card = page.getByRole("article", { name: "Betrieb" });
  await expect(card.getByText(/Datenbank \d+ ms/)).toBeVisible();
  // ohne gekoppelte Sicherung: Warnung
  await expect(card.getByRole("list", { name: "Befunde" })).toContainText("Keine Sicherung eingerichtet");
  await expect(card.locator("code", { hasText: "/api/health/details" })).toBeVisible();
});
