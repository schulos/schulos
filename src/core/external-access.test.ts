import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";
import { CADDY_PUBLIC_PATHS, DEVICE_CERT_HEADER, EMPTY_CERT_FINGERPRINT, EXTERN_HEADER, externalPathAllowed, externalZone, forwardedHeaders, loginPath, PUBLIC_ACCESS_MODES } from "./external-access";

// P4-40 / SICHERHEIT.md S35: Außenzugang – Allowlist der App (zweite Linie hinter Caddy) und die Caddy-Konfiguration in compose.yaml

describe("externalPathAllowed – Allowlist", () => {
  it("lässt genau die öffentlichen Seiten und ihre Unterseiten durch", () => {
    for (const p of [
      "/anmeldung",
      "/anmeldung/",
      "/anmeldung/klasse-5-2027",
      "/anmeldung/bestaetigen/abc123",
      "/anmeldung/vorgang/abc123/termin.ics",
      "/impressum",
      "/impressum/",
      "/datenschutzhinweise",
      "/barrierefreiheit",
      "/api/schule/logo",
      "/icon.png",
      "/favicon.ico",
      "/_next/static/chunks/app-123.js",
      "/_next/static/media/figtree.woff2",
    ])
      expect(externalPathAllowed(p), p).toBe(true);
  });

  it("sperrt alles andere – Login, Startseite, Verwaltung, Export, APIs, Health", () => {
    for (const p of [
      "/",
      "/login",
      "/login/2fa",
      "/verwaltung",
      "/verwaltung/anmeldung",
      "/api/verwaltung/anmeldung-export",
      "/api/auth/get-session",
      "/api/auth/sign-in/username",
      "/api/health",
      "/api/gong/stream",
      "/api/dateien/x.png",
      "/api/schule/logo/x",
      "/monitor/demo-foyer-lindenhof-2026",
      "/dev/mail",
      "/druck/anmeldung/1",
      "/_next/image",
      "/_next/static",
      "/_next/static/",
      "/_next/data/x.json",
      "/heute",
    ])
      expect(externalPathAllowed(p), p).toBe(false);
  });

  it("Präfix nur an Segmentgrenzen: /anmeldungX, /impressumX, /datenschutzhinweise-alt bleiben zu", () => {
    for (const p of ["/anmeldungX", "/anmeldung-export", "/impressumX", "/impressum/unterseite", "/datenschutzhinweise-alt", "/datenschutzhinweise/x", "/icon.png.map"])
      expect(externalPathAllowed(p), p).toBe(false);
  });

  it("Groß/Klein zählt (Caddy vergleicht ohne – die App sperrt den Rest)", () => {
    for (const p of ["/Anmeldung", "/ANMELDUNG/x", "/Impressum", "/API/schule/logo", "/_NEXT/static/x.js"]) expect(externalPathAllowed(p), p).toBe(false);
  });

  it("Pfad-Tricks: Punkt-Segmente, kodierte Zeichen, Backslash, doppelte Schrägstriche, Steuerzeichen", () => {
    for (const p of [
      "/anmeldung/../login",
      "/anmeldung/..",
      "/anmeldung/./x",
      "/anmeldung/.",
      "/anmeldung/%2e%2e/login",
      "/anmeldung/%2E%2E/verwaltung",
      "/anmeldung%2f..%2flogin",
      "/anmeldung/x%2F..%2F..%2Fapi%2Fverwaltung%2Fanmeldung-export",
      "/anmeldung/%5c..%5clogin",
      "/anmeldung\\..\\login",
      "/anmeldung/%00",
      "/anmeldung/%252e%252e/login",
      "//anmeldung",
      "/anmeldung//x",
      "/_next/static/../../login",
      "/anmeldung/\u0000",
      "/anmeldung/x\n",
      "anmeldung",
      "",
    ])
      expect(externalPathAllowed(p), JSON.stringify(p)).toBe(false);
  });

  it("Vorgabe für SCHULOS_PUBLIC_ACCESS ist „keiner“", () => {
    expect(PUBLIC_ACCESS_MODES[0]).toBe("keiner");
  });
});

const req = (url: string, headers: Record<string, string> = {}) => new NextRequest(new URL(url, "https://schulos.test"), { headers });
const extern = { [EXTERN_HEADER]: "1" };
const session = { cookie: "better-auth.session_token=abc.def" };

describe("src/proxy.ts mit X-SchulOS-Extern", () => {
  it("von außen: gesperrte Pfade → 403, auch mit Sitzung und egal welcher Header-Wert", async () => {
    for (const p of ["/login", "/", "/verwaltung", "/api/verwaltung/anmeldung-export", "/api/auth/get-session", "/api/health"]) {
      for (const value of ["1", "0", "", "nein"]) {
        const res = proxy(req(p, { [EXTERN_HEADER]: value, ...session }));
        expect(res.status, `${p} (${value})`).toBe(403);
        expect(await res.text()).toContain("nur im Schulnetz");
      }
    }
  });

  it("von außen: Pfad-Tricks nach der URL-Normalisierung bleiben gesperrt", () => {
    for (const p of ["/anmeldung/../login", "/anmeldung/%2e%2e/verwaltung", "/anmeldung%2f..%2flogin", "/Anmeldung", "/anmeldung/%5c..%5clogin"])
      expect(proxy(req(p, extern)).status, p).toBe(403);
  });

  it("von außen: öffentliche Seiten kommen durch – ohne Cookie und Authorization", () => {
    for (const p of ["/anmeldung", "/anmeldung/klasse-5", "/impressum", "/datenschutzhinweise", "/api/schule/logo", "/_next/static/chunks/a.js", "/icon.png"]) {
      const res = proxy(req(p, { ...extern, ...session, authorization: "Bearer x", "x-forwarded-for": "203.0.113.7" }));
      expect(res.status, p).toBe(200);
      expect(res.headers.get("x-middleware-next"), p).toBe("1");
      const forwarded = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
      expect(forwarded, p).toContain("x-forwarded-for");
      expect(forwarded, p).not.toContain("cookie");
      expect(forwarded, p).not.toContain("authorization");
      expect(res.headers.get("x-middleware-request-cookie"), p).toBeNull();
    }
  });

  it("GATE-4c (N1): von außen bekommt eine Seite mit Dateiendung die CSP, echte statische Dateien nicht", () => {
    expect(proxy(req("/anmeldung/x.js", extern)).headers.get("content-security-policy")).toMatch(/nonce-/);
    expect(proxy(req("/anmeldung/bild.png", extern)).headers.get("content-security-policy")).toMatch(/nonce-/);
    for (const p of ["/_next/static/chunks/a.js", "/icon.png"]) expect(proxy(req(p, extern)).headers.get("content-security-policy"), p).toBeNull();
  });

  it("von innen (ohne Header) unverändert: Login erreichbar, ohne Sitzung zum Login umgeleitet, Cookies bleiben", () => {
    expect(proxy(req("/login")).status).toBe(200);
    const redirect = proxy(req("/verwaltung"));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toContain("/login?next=%2Fverwaltung");
    const withSession = proxy(req("/verwaltung", session));
    expect(withSession.headers.get("x-middleware-request-cookie")).toContain("session_token");
    expect(proxy(req("/api/verwaltung/anmeldung-export")).status).toBe(401);
  });

  it("Matcher: von außen läuft der Proxy immer – auch für Prefetches und Dateiendungen", () => {
    const always = config.matcher.find((m) => "has" in m);
    expect(always).toEqual({ source: "/:path*", has: [{ type: "header", key: EXTERN_HEADER }] });
  });
});

/** Caddyfile aus compose.yaml (`configs: caddyfile`, `$$` = `$` für Compose) */
function caddyfile(): string {
  const lines = readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8").split("\n");
  const at = lines.findIndex((l) => l === "  caddyfile:");
  if (at < 0 || lines[at + 1] !== "    content: |") throw new Error("configs.caddyfile fehlt in compose.yaml");
  const body: string[] = [];
  for (const l of lines.slice(at + 2)) {
    if (l !== "" && !l.startsWith("      ")) break;
    body.push(l.slice(6));
  }
  return body.join("\n").replaceAll("$$", "$");
}

/** Inhalt eines Snippets `(name) { … }` (Zeilen bis zur schließenden Klammer in Spalte 0) */
function snippet(file: string, name: string): string {
  const start = file.indexOf(`(${name}) {\n`);
  if (start < 0) throw new Error(`Snippet ${name} fehlt`);
  const end = file.indexOf("\n}\n", start);
  return file.slice(start, end);
}

/** Inhalt eines benannten Matcher-Blocks `@name { … }` */
function matcherBlock(file: string, name: string): string {
  const start = file.indexOf(`@${name} {\n`);
  if (start < 0) throw new Error(`Matcher @${name} als Block fehlt`);
  return file.slice(start + name.length + 4, file.indexOf("}\n", file.indexOf("\n", start)));
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("Caddy-Konfiguration (compose.yaml)", () => {
  const file = caddyfile();
  const compose = readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8");

  it("Vorgabe „keiner“, je Modus ein Snippet; unbekannter Wert → Import schlägt fehl (Caddy startet nicht)", () => {
    expect(file).toContain("import zugang-{$SCHULOS_PUBLIC_ACCESS:keiner}");
    expect(compose).toContain("SCHULOS_PUBLIC_ACCESS: ${SCHULOS_PUBLIC_ACCESS:-keiner}");
    for (const mode of PUBLIC_ACCESS_MODES) expect(file).toContain(`(zugang-${mode}) {`);
  });

  it("der Header von außen wird immer verworfen, bevor ein Modus greift", () => {
    const site = file.slice(file.indexOf("{$SCHULOS_DOMAIN}, https:// {"));
    expect(site.indexOf("request_header -X-SchulOS-Extern")).toBeGreaterThan(0);
    expect(site.indexOf("request_header -X-SchulOS-Extern")).toBeLessThan(site.indexOf("import zugang-"));
  });

  it("„keiner“: von außen alles 403; „öffentliche Seiten“: Allowlist = Liste der App, Kennzeichnung, ohne Cookies", () => {
    const keiner = snippet(file, "zugang-keiner");
    expect(keiner).toMatch(/@extern not client_ip \{\$SCHULOS_INTERNAL_NETS:private_ranges\}/);
    // von außen: nur mit Gerätezertifikat weiter (P4-40b), sonst 403
    expect(keiner).toMatch(/handle @extern \{\s*import extern-mit-geraet geraet\s*handle \{\s*respond "[^"]+" 403\s*\}\s*\}/);

    const oeff = snippet(file, "zugang-oeffentliche-seiten");
    const paths = /@oeffentlich path (.+)/.exec(oeff)?.[1]?.trim().split(/\s+/);
    expect(paths?.sort()).toEqual([...CADDY_PUBLIC_PATHS].sort());
    for (const line of ["request_header X-SchulOS-Extern 1", "request_header -Cookie", "request_header -Authorization", "handle @oeffentlich {"])
      expect(oeff).toContain(line);
    // Rest von außen: 403 (letzter handle-Block im extern-Zweig)
    expect(oeff).toMatch(/handle \{\s*respond "[^"]+" 403\s*\}/);
  });

  it("P4-40b: Geräte-Header wird immer verworfen; gesetzt nur im Zweig mit verifiziertem Zertifikat, je Modus gekennzeichnet", () => {
    const site = file.slice(file.indexOf("{$SCHULOS_DOMAIN}, https:// {"));
    const strip = site.indexOf("request_header -X-SchulOS-Geraet");
    expect(strip).toBeGreaterThan(0);
    expect(strip).toBeLessThan(site.indexOf("import zugang-"));
    // nur ein verifiziertes Zertifikat setzt den Fingerabdruck – nirgends sonst wird der Header gesetzt
    // Fix (CI-Stack rot, P4-40b): ohne Client-Zertifikat liefert Caddy 2.11 für den Fingerabdruck SHA-256("") = e3b0…b855,
    // keinen leeren Wert – ein Matcher allein auf den Fingerabdruck traf damit JEDE Anfrage von außen (fail-open)
    const geraet = matcherBlock(site, "geraet");
    expect(geraet).toMatch(/^\s*vars_regexp \{http\.request\.tls\.client\.certificate_der_base64\} \^\[A-Za-z0-9\+\/\]\+=\*\$\s*$/m);
    expect(geraet).toContain(`not vars {http.request.tls.client.fingerprint} ${EMPTY_SHA256}`);
    // kein zweiter vars_regexp im Block (mehrere Schlüssel eines vars_regexp-Matchers sind ODER-verknüpft)
    expect(geraet.match(/vars_regexp/g)).toHaveLength(1);
    expect(file).not.toMatch(/vars_regexp \{http\.request\.tls\.client\.fingerprint\}/);
    expect(file.match(/request_header X-SchulOS-Geraet /g)).toHaveLength(1);
    const mitGeraet = snippet(file, "extern-mit-geraet");
    expect(mitGeraet).toMatch(/handle @geraet \{\s*request_header X-SchulOS-Extern \{args\[0\]\}\s*request_header X-SchulOS-Geraet \{http\.request\.tls\.client\.fingerprint\}\s*import app\s*\}/);
    // jeder Modus: von außen zuerst der Gerätezweig, danach der bisherige Weg; „alles“ kennzeichnet jetzt ebenfalls
    expect(snippet(file, "zugang-keiner")).toContain("import extern-mit-geraet geraet");
    expect(snippet(file, "zugang-oeffentliche-seiten")).toContain("import extern-mit-geraet geraet");
    const alles = snippet(file, "zugang-alles");
    expect(alles).toContain("import extern-mit-geraet alles");
    expect(alles).toMatch(/handle \{\s*request_header X-SchulOS-Extern alles\s*import app\s*\}/);
    // im Zweig ohne Zertifikat bleiben Cookies weg (öffentliche Seiten)
    const oeff = snippet(file, "zugang-oeffentliche-seiten");
    expect(oeff.indexOf("import extern-mit-geraet geraet")).toBeLessThan(oeff.indexOf("request_header -Cookie"));
  });

  it("P4-40b: client_auth nur mit SCHULOS_DEVICE_CERTS=an, verify_if_given gegen die Schul-CA; Vorgabe aus", () => {
    expect(file).toMatch(/tls \{\$SCHULOS_TLS\} \{\s*import tls-geraete-\{\$SCHULOS_DEVICE_CERTS:aus\}\s*\}/);
    expect(snippet(file, "tls-geraete-aus").replace(/\s/g, "")).toBe("(tls-geraete-aus){");
    const an = snippet(file, "tls-geraete-an");
    expect(an).toContain("mode verify_if_given");
    expect(an).toContain("trust_pool file /etc/caddy/geraete-ca/root_ca.crt /etc/caddy/geraete-ca/intermediate_ca.crt");
    expect(compose).toContain("SCHULOS_DEVICE_CERTS: ${SCHULOS_DEVICE_CERTS:-aus}");
    expect(compose).toContain("- geraete_ca:/etc/caddy/geraete-ca:ro");
    // step-ca nur als Profil, nicht von außen erreichbar (kein ports, nur internes Netz)
    const stepCa = compose.slice(compose.indexOf("\n  step-ca:"), compose.indexOf("\n  # Backup-Agent"));
    expect(stepCa).toContain("profiles: [geraete]");
    expect(stepCa).not.toContain("ports:");
    expect(stepCa).toContain("networks: [ca]");
    expect(compose).toMatch(/\n {2}ca:\n {4}internal: true/);
  });

  it("hinter einem Proxy zählt X-Forwarded-For nur von eingetragenen Adressen, von rechts gelesen", () => {
    expect(file).toContain("trusted_proxies static {$SCHULOS_TRUSTED_PROXIES:127.0.0.1/32}");
    expect(file).toContain("trusted_proxies_strict");
    expect(file).toContain("header_up X-Forwarded-For {client_ip}");
  });
});

// P4-40b: Zonen und Geräte-Header (SICHERHEIT.md S27)
describe("externalZone / deviceFingerprint – Kennzeichen von Caddy, im Zweifel eng", () => {
  const fp = "ab".repeat(32);
  const z = (h: Record<string, string>) => externalZone(new Headers(h));

  it("ohne Kennzeichen intern – ein mitgeschickter Geräte-Header ändert daran nichts", () => {
    expect(z({})).toBe("intern");
    expect(z({ [DEVICE_CERT_HEADER]: fp })).toBe("intern");
  });

  it("„alles“ und „geraet“ nur genau so; „geraet“ nur mit Fingerabdruck in Caddy-Form, sonst Allowlist", () => {
    expect(z({ [EXTERN_HEADER]: "alles" })).toBe("alles");
    expect(z({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp })).toBe("geraet");
    for (const bad of ["", "AB".repeat(32), "ab".repeat(31), `${fp}, ${fp}`, `${fp}0`, "zz".repeat(32)])
      expect(z({ [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: bad }), bad).toBe("oeffentlich");
    expect(z({ [EXTERN_HEADER]: "geraet" })).toBe("oeffentlich");
    for (const v of ["1", "", "Alles", "alles, 1", "GERAET", "intern", "0"]) expect(z({ [EXTERN_HEADER]: v }), v).toBe("oeffentlich");
  });

  it("forwardedHeaders: Fingerabdruck nur in alles/geraet; öffentlich ohne Cookie; intern ohne Geräte-Header", () => {
    const base = { cookie: "a=b", authorization: "x", [DEVICE_CERT_HEADER]: fp };
    expect(forwardedHeaders(new Headers({ cookie: "a=b" }), "intern")).toBeNull();
    const intern = forwardedHeaders(new Headers(base), "intern")!;
    expect(intern.has(DEVICE_CERT_HEADER)).toBe(false);
    expect(intern.get("cookie")).toBe("a=b");
    const oeff = forwardedHeaders(new Headers(base), "oeffentlich")!;
    expect([oeff.has(DEVICE_CERT_HEADER), oeff.has("cookie"), oeff.has("authorization")]).toEqual([false, false, false]);
    const geraet = forwardedHeaders(new Headers(base), "geraet")!;
    expect([geraet.get(DEVICE_CERT_HEADER), geraet.get("cookie")]).toEqual([fp, "a=b"]);
    expect(forwardedHeaders(new Headers({ ...base, [DEVICE_CERT_HEADER]: "kaputt" }), "alles")!.has(DEVICE_CERT_HEADER)).toBe(false);
  });

  it("Anmeldepfade von außen: Login-Seiten und genau drei Auth-Endpunkte", () => {
    for (const p of ["/login", "/login/zweiter-faktor", "/api/auth/sign-in/username", "/api/auth/sign-out", "/api/auth/get-session"]) expect(loginPath(p), p).toBe(true);
    for (const p of ["/loginx", "/api/auth/list-sessions", "/api/auth/revoke-sessions", "/api/auth/two-factor/get-totp-uri", "/api/auth/sign-in/username/x"]) expect(loginPath(p), p).toBe(false);
  });
});

describe("src/proxy.ts mit Gerätezertifikat bzw. Modus „alles“ (P4-40b)", () => {
  const fp = "cd".repeat(32);
  const geraet = { [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp };

  it("mit Zertifikat: Login erreichbar, Sitzung bleibt, geprüfter Fingerabdruck geht weiter", () => {
    const res = proxy(req("/login", geraet));
    expect(res.status).toBe(200);
    const res2 = proxy(req("/verwaltung", { ...geraet, ...session }));
    expect(res2.headers.get("x-middleware-request-cookie")).toContain("session_token");
    expect(res2.headers.get(`x-middleware-request-${DEVICE_CERT_HEADER}`)).toBe(fp);
  });

  it("mit Zertifikat: Seiten ohne Anmeldung außerhalb der Allowlist (Monitore, Health, Dev) bleiben zu", () => {
    for (const p of ["/monitor/demo-foyer-lindenhof-2026", "/api/monitor/x", "/api/health", "/api/auth/list-sessions"]) expect(proxy(req(p, geraet)).status, p).toBe(403);
    expect(proxy(req("/anmeldung", geraet)).status).toBe(200);
  });

  it("„geraet“ ohne bzw. mit kaputtem Fingerabdruck = nur Allowlist (gefälschter Header ohne Zertifikat)", () => {
    expect(proxy(req("/login", { [EXTERN_HEADER]: "geraet" })).status).toBe(403);
    expect(proxy(req("/login", { [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: "x" })).status).toBe(403);
  });

  it("Fix: Leer-Hash (Caddy ohne Client-Zertifikat) gilt nie als Gerät – genau die Fälle aus dem roten Stack-Test", () => {
    const leer = { [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: EMPTY_SHA256 };
    expect(EMPTY_CERT_FINGERPRINT).toBe(EMPTY_SHA256);
    expect(externalZone(new Headers(leer))).toBe("oeffentlich");
    for (const p of ["/login", "/", "/verwaltung", "/api/auth/get-session", "/api/verwaltung/anmeldung-export", "/dev/mail", "/ANMELDUNG", "/Login"])
      expect(proxy(req(p, leer)).status, p).toBe(403);
    expect(proxy(req("/", { ...leer, ...session })).status).toBe(403);
    expect(proxy(req("/impressum", leer)).status).toBe(200);
    // auch in „alles“ kein Fingerabdruck weiterreichen
    const res = proxy(req("/verwaltung", { [EXTERN_HEADER]: "alles", [DEVICE_CERT_HEADER]: EMPTY_SHA256, ...session }));
    expect((res.headers.get("x-middleware-override-headers") ?? "").split(",")).not.toContain(DEVICE_CERT_HEADER);
  });

  it("Modus „alles“: Login, Seiten mit Sitzung, Auth-API nur Anmelden/Abmelden/Sitzung; statische Dateien ohne Umleitung", () => {
    const alles = { [EXTERN_HEADER]: "alles" };
    expect(proxy(req("/login", alles)).status).toBe(200);
    expect(proxy(req("/monitor/demo-foyer-lindenhof-2026", alles)).status).toBe(200);
    expect(proxy(req("/api/auth/sign-in/username", alles)).status).toBe(200);
    expect(proxy(req("/api/auth/revoke-other-sessions", alles)).status).toBe(403);
    expect(proxy(req("/_next/static/chunks/a.js", alles)).status).toBe(200);
    expect(proxy(req("/verwaltung", alles)).status).toBe(307);
    // ein mitgeschickter, aber kaputter Geräte-Header wird entfernt
    const res = proxy(req("/verwaltung", { ...alles, ...session, [DEVICE_CERT_HEADER]: "AB".repeat(32) }));
    expect((res.headers.get("x-middleware-override-headers") ?? "").split(",")).not.toContain(DEVICE_CERT_HEADER);
  });

  it("Modus „alles“: Seiten ohne Anmeldung (Health, Monitore) mit und ohne Zertifikat gleich – das Zertifikat ändert dort nichts", () => {
    // Stack-Test P4-40b erwartete mit Zertifikat 403, obwohl dieselben Pfade in „alles“ ohne Zertifikat offen sind (§5b)
    const alles = { [EXTERN_HEADER]: "alles" };
    for (const p of ["/api/health", "/monitor/demo-foyer-lindenhof-2026", "/anmeldung", "/impressum"]) {
      const ohne = proxy(req(p, alles)).status;
      expect(ohne, p).toBe(200);
      expect(proxy(req(p, { ...alles, [DEVICE_CERT_HEADER]: fp })).status, p).toBe(ohne);
    }
    // in „keiner“ (Zone geraet) bleiben sie dagegen zu – ohne Zertifikat sperrt dort schon Caddy
    for (const p of ["/api/health", "/monitor/demo-foyer-lindenhof-2026"]) expect(proxy(req(p, geraet)).status, p).toBe(403);
  });

  it("im Schulnetz wird ein mitgeschickter Geräte-Header entfernt", () => {
    const res = proxy(req("/verwaltung", { ...session, [DEVICE_CERT_HEADER]: fp }));
    expect((res.headers.get("x-middleware-override-headers") ?? "").split(",")).not.toContain(DEVICE_CERT_HEADER);
    expect(config.matcher).toContainEqual({ source: "/:path*", has: [{ type: "header", key: DEVICE_CERT_HEADER }] });
  });
});

describe("Kalender-Abo (Q5-15) im Proxy", () => {
  const abo = `/api/kalender/abo/${"a".repeat(43)}`;
  const fp = "ab".repeat(32);
  it("im Schulnetz ohne Sitzung erreichbar (kein 401), von außen nur im Modus „alles“", () => {
    const inside = proxy(req(abo));
    expect(inside.status).toBe(200);
    expect(inside.headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req(abo, extern)).status).toBe(403);
    // mit Gerätezertifikat durchgelassen: sitzungsfreie Routen außerhalb der Allowlist bleiben zu (S27)
    expect(proxy(req(abo, { [EXTERN_HEADER]: "geraet", [DEVICE_CERT_HEADER]: fp })).status).toBe(403);
    expect(proxy(req(abo, { [EXTERN_HEADER]: "alles" })).status).toBe(200);
  });
});
