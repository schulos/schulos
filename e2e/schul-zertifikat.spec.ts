import { X509Certificate } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// CA-03/CA-04: Schul-Zertifikat (Root der eigenen CA). schulosctl legt es auf dem Server als config/root-ca.crt ab – hier legt der
// Test eine Test-CA dorthin. Der E2E-Server steht ohne Reverse-Proxy: ohne X-Forwarded-For gilt eine Anfrage als Schulnetz.
const configDir = path.join(process.cwd(), ".data", "config");
const rootFile = path.join(configDir, "root-ca.crt");
const fixture = (f: string) => path.join(process.cwd(), "packages", "server", "test-fixtures", f);
const fp = (f: string) => new X509Certificate(readFileSync(fixture(f))).fingerprint256;

test("Schul-Zertifikat: /ca.crt nur im Schulnetz, Download für Admin, Wechsel bestätigen", async ({ page, request }) => {
  // ohne eigene CA: nichts auszuliefern
  rmSync(rootFile, { force: true });
  expect((await request.get("/ca.crt")).status()).toBe(404);

  mkdirSync(configDir, { recursive: true });
  copyFileSync(fixture("ca.pem"), rootFile);
  try {
    // ohne Anmeldung im Schulnetz: nur das Zertifikat
    const res = await request.get("/ca.crt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/x-x509-ca-cert");
    const pem = await res.text();
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(pem).not.toContain("PRIVATE KEY");
    expect(new X509Certificate(pem).fingerprint256).toBe(fp("ca.pem"));
    // fremde Adresse bzw. von außen: nicht vorhanden bzw. schon vom Proxy gesperrt
    expect((await request.get("/ca.crt", { headers: { "x-forwarded-for": "8.8.8.8" } })).status()).toBe(404);
    expect((await request.get("/ca.crt", { headers: { "x-schulos-extern": "1" } })).status()).toBe(403);
    expect((await request.get("/ca.crt", { headers: { "x-schulos-extern": "alles" } })).status()).toBe(404);
    // angemeldeter Download nur mit Anmeldung
    expect((await request.get("/api/system/ca")).status()).toBe(401);

    await login(page, "admin");
    await page.goto("/verwaltung/system");
    const card = page.getByRole("article", { name: "Schul-Zertifikat" });
    await expect(card.getByLabel("Fingerabdruck")).toContainText(fp("ca.pem").slice(0, 47));
    await expect(card.getByRole("link", { name: "iPad/Mac (.mobileconfig)" })).toBeVisible();
    // erste Root gilt als bestätigt – kein Hinweis
    await expect(card.getByRole("alert")).toHaveCount(0);
    const cer = await page.request.get("/api/system/ca?format=cer");
    expect(cer.status()).toBe(200);
    expect(new X509Certificate(await cer.body()).fingerprint256).toBe(fp("ca.pem"));
    const mc = await page.request.get("/api/system/ca?format=mobileconfig");
    expect(mc.headers()["content-type"]).toBe("application/x-apple-aspen-config");
    expect(await mc.text()).toContain("com.apple.security.root");
    expect((await page.request.get("/api/system/ca?format=key")).status()).toBe(400);

    // Wechsel der Root (z. B. Neuinstallation): Hinweis + Bestätigung, danach ruhig
    copyFileSync(fixture("other-ca.pem"), rootFile);
    await page.reload();
    await expect(card.getByRole("alert")).toContainText("Neues Schul-Zertifikat");
    await card.getByRole("button", { name: "Neues Zertifikat bestätigen" }).click();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(card.getByLabel("Fingerabdruck")).toContainText(fp("other-ca.pem").slice(0, 47));
  } finally {
    rmSync(rootFile, { force: true });
  }
  expect((await request.get("/ca.crt")).status()).toBe(404);
});

test("Schul-Zertifikat: Download nicht für Lehrkräfte", async ({ page }) => {
  await login(page, "jana.brandt");
  expect((await page.request.get("/api/system/ca")).status()).toBe(403);
});
