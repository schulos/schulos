// SEC-15: CrowdSec-Sperren in der App (Bouncer) – Zwischenspeicher, Stream-Abgleich, Proxy. Gegen ein echtes CrowdSec
// (cscli decisions add → 403) läuft nur die CI (Job „stack“).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  activeBans,
  applyStream,
  crowdsecBlocked,
  crowdsecConfig,
  crowdsecOnlyRequest,
  crowdsecStatus,
  emptyCache,
  isBanned,
  parseGoDuration,
  pull,
  startCrowdsecSync,
  stopCrowdsecSync,
} from "./crowdsec";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const json = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("SEC-15: CrowdSec-Sperren", () => {
  it("Einstellung nur mit Adresse und Schlüssel", () => {
    expect(crowdsecConfig({})).toBeNull();
    expect(
      crowdsecConfig({ SCHULOS_CROWDSEC_URL: "http://crowdsec:8080" }),
    ).toBeNull();
    expect(
      crowdsecConfig({
        SCHULOS_CROWDSEC_URL: "http://crowdsec:8080/",
        SCHULOS_CROWDSEC_BOUNCER_KEY: "k",
      }),
    ).toEqual({
      url: "http://crowdsec:8080",
      key: "k",
    });
    expect(
      crowdsecConfig({
        SCHULOS_CROWDSEC_URL: "file:///etc/passwd",
        SCHULOS_CROWDSEC_BOUNCER_KEY: "k",
      }),
    ).toBeNull();
  });

  it("Go-Dauern", () => {
    expect(parseGoDuration("3h59m58.1s")).toBe(
      3 * 3600_000 + 59 * 60_000 + 58_100,
    );
    expect(parseGoDuration("5m")).toBe(300_000);
    expect(parseGoDuration("-1s")).toBe(0);
    expect(parseGoDuration(5)).toBe(0);
  });

  it("Stream: neue Sperren (IP, IPv4-Bereich), Ablauf, gelöscht; nur „ban“", () => {
    const c = emptyCache();
    applyStream(
      c,
      {
        new: [
          { value: "203.0.113.7", scope: "Ip", type: "ban", duration: "4h" },
          {
            value: "198.51.100.0/24",
            scope: "Range",
            type: "ban",
            duration: "1h",
          },
          { value: "2001:DB8::1", scope: "Ip", type: "ban", duration: "1h" },
          { value: "192.0.2.1", scope: "Ip", type: "captcha", duration: "1h" },
        ],
      },
      NOW,
    );
    expect(isBanned(c, "203.0.113.7", NOW)).toBe(true);
    expect(isBanned(c, "198.51.100.42", NOW)).toBe(true);
    expect(isBanned(c, "198.51.101.1", NOW)).toBe(false);
    expect(isBanned(c, "2001:db8::1", NOW)).toBe(true);
    expect(isBanned(c, "192.0.2.1", NOW)).toBe(false);
    expect(activeBans(c, NOW)).toBe(3);
    expect(isBanned(c, "198.51.100.42", NOW + 2 * 3600_000)).toBe(false); // abgelaufen
    applyStream(c, { deleted: [{ value: "203.0.113.7" }] }, NOW);
    expect(isBanned(c, "203.0.113.7", NOW)).toBe(false);
  });

  it("Abgleich: volle Liste der aktiven Sperren (echte LAPI-Antwortform) ersetzt den Stand; null = keine; Fehler gemerkt, Stand bleibt", async () => {
    const c = emptyCache();
    const urls: string[] = [];
    // so antwortet CrowdSec 1.x auf GET /v1/decisions nach `cscli decisions add --ip 10.99.0.7 --duration 10m --reason ci`
    const lapi = [
      {
        duration: "9m58.366211393s",
        id: 1,
        origin: "cscli",
        scenario: "ci",
        scope: "Ip",
        type: "ban",
        uuid: "4b3c2f8e-1d6a-4a3e-9a51-6c0f1f2b9e11",
        value: "10.99.0.7",
      },
    ];
    let body: unknown = lapi;
    const api = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)["X-Api-Key"]).toBe("k");
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const cfg = { url: "http://crowdsec:8080", key: "k" };
    await pull(cfg, c, api, NOW);
    expect(urls).toEqual(["http://crowdsec:8080/v1/decisions"]);
    expect(isBanned(c, "10.99.0.7", NOW)).toBe(true);
    expect(isBanned(c, "10.99.0.8", NOW)).toBe(false);
    // ein zweiter Abrufer (eigener Zwischenspeicher, gleicher Schlüssel) sieht dieselbe Sperre – kein „verbrauchter“ Stream
    const other = emptyCache();
    await pull(cfg, other, api, NOW);
    expect(isBanned(other, "10.99.0.7", NOW)).toBe(true);
    // Sperre aufgehoben: LAPI antwortet mit null → nichts mehr gesperrt
    body = null;
    await pull(cfg, c, api, NOW + 10_000);
    expect(isBanned(c, "10.99.0.7", NOW + 10_000)).toBe(false);
    body = lapi;
    await pull(cfg, c, api, NOW + 20_000);
    await pull(cfg, c, json({}, 500), NOW + 30_000);
    expect(c.error).toContain("500");
    expect(isBanned(c, "10.99.0.7", NOW + 30_000)).toBe(true);
  });

  it("Serverstart: erster Abgleich abgewartet – gesperrte Adresse gleich bei der ersten Anfrage gesperrt; ohne Einstellung nichts", async () => {
    const g = globalThis as unknown as { __schulosCrowdsec?: unknown };
    const env = { SCHULOS_CROWDSEC_URL: "http://crowdsec:8080", SCHULOS_CROWDSEC_BOUNCER_KEY: "k" };
    g.__schulosCrowdsec = emptyCache();
    let calls = 0;
    const api = (async () => {
      calls++;
      return new Response(JSON.stringify([{ value: "10.99.0.7", scope: "Ip", type: "ban", duration: "9m" }]));
    }) as unknown as typeof fetch;
    try {
      expect(await startCrowdsecSync({}, api)).toBe(false);
      expect(await startCrowdsecSync(env, api)).toBe(true);
      expect(calls).toBe(1);
      expect(crowdsecBlocked("10.99.0.7", env)).toBe(true);
      expect(crowdsecBlocked("10.99.0.8", env)).toBe(false);
      // nur einmal je Prozess
      expect(await startCrowdsecSync(env, api)).toBe(false);
    } finally {
      stopCrowdsecSync();
      g.__schulosCrowdsec = emptyCache();
    }
  });

  it("CrowdSec beim Serverstart noch nicht erreichbar: fail open nur bis zum nächsten 10-s-Abgleich, nicht dauerhaft", async () => {
    const g = globalThis as unknown as { __schulosCrowdsec?: unknown };
    const env = { SCHULOS_CROWDSEC_URL: "http://crowdsec:8080", SCHULOS_CROWDSEC_BOUNCER_KEY: "k" };
    g.__schulosCrowdsec = emptyCache();
    let up = false;
    const api = (async () => {
      if (!up) throw new TypeError("fetch failed");
      return new Response(JSON.stringify([{ value: "10.99.0.7", scope: "Ip", type: "ban", duration: "9m" }]));
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      expect(await startCrowdsecSync(env, api)).toBe(true);
      expect(crowdsecBlocked("10.99.0.7", env)).toBe(false);
      up = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(crowdsecBlocked("10.99.0.7", env)).toBe(true);
    } finally {
      stopCrowdsecSync();
      vi.useRealTimers();
      g.__schulosCrowdsec = emptyCache();
    }
  });

  it("ohne Einstellung nie gesperrt; Status für Verwaltung → System", async () => {
    expect(crowdsecBlocked("203.0.113.7", {})).toBe(false);
    expect(
      await crowdsecStatus(
        { url: "http://x", key: "k" },
        json([
          { value: "1.2.3.4", type: "ban" },
          { value: "5.6.7.8", type: "captcha" },
        ]),
      ),
    ).toEqual({
      ok: true,
      active: 1,
    });
    expect(
      await crowdsecStatus({ url: "http://x", key: "k" }, json([], 403)),
    ).toMatchObject({ ok: false });
  });

  it("Proxy prüft vor allem anderen (außer Wartung); Compose ohne Online-API, Protokoll nur mit SCHULOS_CROWDSEC=1", () => {
    const root = path.resolve(__dirname, "../..");
    const proxy = readFileSync(path.join(root, "src/proxy.ts"), "utf8");
    expect(proxy.indexOf("crowdsecBlocked(")).toBeGreaterThan(
      proxy.indexOf("readMaintenance()"),
    );
    expect(proxy.indexOf("crowdsecBlocked(")).toBeLessThan(
      proxy.indexOf("externalZone(req.headers)"),
    );
    const compose = readFileSync(path.join(root, "compose.yaml"), "utf8");
    // ohne yaml-Paket (gehört nur dem Installer; der Docker-Build prüft auch Testdateien): Block des Dienstes als Text
    const start = compose.indexOf("\n  crowdsec:\n");
    const block = compose.slice(start, compose.indexOf("\n\n", start));
    expect(block).toContain("profiles: [crowdsec]");
    expect(block).toContain('DISABLE_ONLINE_API: "true"');
    expect(compose).toContain("import crowdsec-{$$SCHULOS_CROWDSEC:0}");
    expect(compose).toMatch(/\(crowdsec-0\) \{\s*\}/);
    // G4E-O11: zeitbasiert drehen (24 h) + gedrehte Dateien 1 Tag → nichts älter als 48 h; Tokens im Pfad maskiert
    expect(compose).toContain("roll_interval 24h");
    // CI-Befund GATE-4e: CrowdSec muss den Ordner beobachten, auch wenn access.log beim Start noch fehlt
    const acquis = compose.slice(compose.indexOf("  crowdsec-acquis:"), compose.indexOf("  step-ca-start:"));
    expect(acquis).toContain("- /var/log/caddy/access.log");
    expect(acquis).toContain("force_inotify: true");
    expect(acquis).toContain("type: caddy");
    expect(compose).toContain("roll_keep_for 24h");
    expect(compose).toContain("request>uri regexp `[A-Za-z0-9_-]{20,}` ***");
    // G4E-O13: Sperre auch für Prefetch-Header und Pfade mit Dateiendung im Schulnetz
    expect(proxy).toContain('{ source: "/:path*", has: [{ type: "header", key: "next-router-prefetch" }] }');
    expect(proxy).toContain('{ source: "/:path*", has: [{ type: "header", key: "purpose", value: "prefetch" }] }');
    expect(proxy).toContain("(?!_next/static|_next/image|favicon.ico).*");
  });

  it("G4E-O13: welche Anfragen nur wegen der Sperre durch den Proxy laufen (danach unverändert weiter)", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(crowdsecOnlyRequest("/stundenplan", h({ "next-router-prefetch": "1" }))).toBe(true);
    expect(crowdsecOnlyRequest("/stundenplan", h({ purpose: "prefetch" }))).toBe(true);
    expect(crowdsecOnlyRequest("/api/dateien/x.png", h({}))).toBe(true);
    expect(crowdsecOnlyRequest("/stundenplan", h({}))).toBe(false);
    // von außen gekennzeichnet: volle Prüfung wie bisher
    expect(crowdsecOnlyRequest("/api/dateien/x.png", h({ "x-schulos-extern": "1" }))).toBe(false);
    expect(crowdsecOnlyRequest("/x", h({ "next-router-prefetch": "1", "x-schulos-geraet": "ab" }))).toBe(false);
  });
});
