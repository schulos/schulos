import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

// BM-05/BM-06: Zähler aus dem IP-freien Protokoll des Proxys (im E2E legt die Spec die Datei selbst ab, playwright.config.ts)
// und der VVT-Eintrag „Betriebsüberwachung“
test("Zugriffe: Zähler aus dem Betriebsprotokoll, Befund bei vielen Serverfehlern; VVT-Eintrag Betriebsüberwachung", async ({ page, request }) => {
  const dir = path.join(process.cwd(), ".data", "e2e-betrieb");
  mkdirSync(dir, { recursive: true });
  const ts = Date.now() / 1000 - 60;
  const row = (status: number) => JSON.stringify({ level: "info", ts, logger: "http.log.access.betrieb", msg: "handled request", duration: 0.02, size: 100, status });
  writeFileSync(path.join(dir, "betrieb.log"), [...Array.from({ length: 18 }, () => row(200)), row(502), row(502)].join("\n") + "\n");
  try {
    const report = await (await request.get("/api/health/details")).json();
    expect(report.traffic.lastHour).toMatchObject({ requests: 20, byClass: { "2xx": 18, "5xx": 2 }, errorRate: 10 });
    expect(report.problems.map((p: { key: string }) => p.key)).toContain("zugriffe:5xx");
    // nichts im Bericht deutet auf IP, Pfad oder Konto
    expect(JSON.stringify(report.traffic)).not.toMatch(/ip|uri|host|user/i);

    await login(page, "admin");
    await page.goto("/verwaltung/system");
    const card = page.getByRole("article", { name: "Betrieb" });
    await expect(card.getByRole("group", { name: "Zugriffe" })).toContainText("Zugriffe letzte Stunde 20 · Serverfehler 10 %");
    await expect(card.getByRole("list", { name: "Befunde" })).toContainText("10 % Serverfehler in der letzten Stunde (2 von 20 Anfragen)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // ohne Protokoll: kein Abschnitt, kein Befund
  expect((await (await request.get("/api/health/details")).json()).traffic).toBeNull();

  await page.goto("/druck/vvt");
  await expect(page.getByRole("heading", { name: /Betriebsüberwachung/ })).toBeVisible();
  await expect(page.getByText(/höchstens 48 Stunden/).first()).toBeVisible();
});
