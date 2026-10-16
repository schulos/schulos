import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// GATE-4c (Security „prüfen“ 1): Von außen (Kennzeichen von Caddy, hier direkt gesetzt – E2E läuft ohne Caddy) erreicht eine
// POST auf eine erlaubte Seite mit `Next-Action` nur die öffentlichen Actions der Schulanmeldung. Next würde eine fremde
// Action-ID (z. B. loginAction) an den Worker ihrer Seite weiterleiten – das darf nie von einem Next-Update abhängen.
type Manifest = { node: Record<string, { filename: string; exportedName: string }> };
// erst im Test lesen: Playwright lädt alle Specs auch bei Filter (@iso gegen die ISO-Demo läuft ohne .next)
let cached: Manifest | undefined;
const manifest = {
  get node() {
    cached ??= JSON.parse(readFileSync(path.join(process.cwd(), ".next", "server", "server-reference-manifest.json"), "utf8")) as Manifest;
    return cached.node;
  },
};
// Pfade im Manifest sind je nach Build absolut (lokal) oder relativ zu src/ (CI: „app/…“, „modules/…“) – vorn immer mit „/“ vergleichen
const fileOf = (v: { filename: string }) => "/" + v.filename.replace(/\\/g, "/").replace(/^\/+/, "");
const idOf = (name: string, file?: string) =>
  Object.entries(manifest.node).find(([, v]) => v.exportedName === name && (!file || fileOf(v).includes(file)))?.[0];

test("von außen: interne Server Action über /anmeldung → 403, öffentliche Action geht", async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const login = idOf("loginAction");
  const verwaltung = Object.entries(manifest.node).find(([, v]) => fileOf(v).includes("/modules/verwaltung/"))?.[0];
  const slots = idOf("freeSlotsAction", "/modules/anmeldung/public-actions.ts");
  expect(
    { login, verwaltung, slots },
    `Manifest-Beispiele: ${Object.values(manifest.node).slice(0, 3).map((v) => `${v.exportedName} @ ${v.filename}`).join(" | ")}`,
  ).toEqual({ login: expect.any(String), verwaltung: expect.any(String), slots: expect.any(String) });
  for (const [p, id] of [
    ["/anmeldung", login],
    ["/anmeldung", verwaltung],
    ["/anmeldung/bestaetigen/" + "x".repeat(43), login],
  ] as const) {
    const res = await request.post(p, {
      headers: { "x-schulos-extern": "1", "next-action": id!, origin, "content-type": "text/plain;charset=UTF-8" },
      data: JSON.stringify(["admin", "falsch"]),
      maxRedirects: 0,
    });
    expect(res.status(), `${p} ${id}`).toBe(403);
    expect(await res.text()).toContain("nur im Schulnetz");
  }
  // Gegenprobe: die öffentliche Action (freie Termine) läuft von außen – unbekanntes Verfahren → leere Liste, kein 403
  const ok = await request.post("/anmeldung/bestaetigen/" + "x".repeat(43), {
    headers: { "x-schulos-extern": "1", "next-action": slots!, origin, "content-type": "text/plain;charset=UTF-8" },
    data: JSON.stringify(["gibts-nicht"]),
    maxRedirects: 0,
  });
  expect(ok.status()).toBe(200);
});
