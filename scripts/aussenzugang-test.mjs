// Stack-Test Außenzugang (P4-40, SICHERHEIT.md S35) gegen den laufenden Compose-Stack – CI-Job `stack`.
// „Von außen“ wird simuliert: der Stack läuft mit SCHULOS_TRUSTED_PROXIES=private_ranges (der Docker-Gateway gilt als Proxy),
// die Anfrage bringt X-Forwarded-For mit einer öffentlichen Adresse (203.0.113.7, TEST-NET-3) mit. Ohne Header = Schulnetz.
// Rohe Pfade (mit `..`, kodierten Zeichen) gehen über node:https – fetch würde sie vorher normalisieren.
// Aufruf: node scripts/aussenzugang-test.mjs <basis-url> <keiner|oeffentliche-seiten|alles> [--insecure]
import https from "node:https";
import http from "node:http";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const insecure = process.argv.includes("--insecure");
const base = new URL(args[0] ?? "https://localhost:8443");
const mode = args[1];
if (!["keiner", "oeffentliche-seiten", "alles"].includes(mode ?? "")) {
  console.error("Aufruf: node scripts/aussenzugang-test.mjs <basis-url> <keiner|oeffentliche-seiten|alles> [--insecure]");
  process.exit(2);
}

const EXTERN = { "x-forwarded-for": "203.0.113.7" };
const INTERN = { "x-forwarded-for": "10.1.2.3" };

/** GET mit rohem Pfad; liefert Status und Text */
function get(rawPath, headers = {}) {
  const lib = base.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { host: base.hostname, port: base.port, path: rawPath, method: "GET", headers: { host: base.host, ...headers }, rejectUnauthorized: !insecure },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`Zeitüberschreitung bei ${rawPath}`)));
    req.end();
  });
}

let failed = 0;
async function expectStatus(label, rawPath, headers, allowed) {
  const r = await get(rawPath, headers);
  const ok = allowed.includes(r.status);
  console.log(`${ok ? "✓" : "✗"} ${label}: ${rawPath} → ${r.status}${ok ? "" : ` (erwartet ${allowed.join("/")})`}`);
  if (!ok) failed++;
  return r;
}

const blocked = ["/login", "/", "/verwaltung", "/api/health", "/api/auth/get-session", "/api/verwaltung/anmeldung-export", "/monitor/demo-foyer-lindenhof-2026", "/dev/mail"];
const publicPages = ["/impressum", "/datenschutzhinweise", "/icon.png"];

// Caddy wurde gerade neu erstellt – warten, bis er antwortet
for (let i = 0; ; i++) {
  try {
    if ((await get("/login", INTERN)).status === 200) break;
  } catch {
    // noch nicht erreichbar
  }
  if (i >= 60) {
    console.error("Caddy antwortet nicht");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// Schulnetz: immer alles wie gehabt; ein mitgeschickter Kennzeichnungs-Header wird von Caddy verworfen (sonst sperrte die App)
await expectStatus("intern Login", "/login", INTERN, [200]);
await expectStatus("intern ohne X-Forwarded-For", "/login", {}, [200]);
await expectStatus("intern, gefälschter X-SchulOS-Extern", "/login", { ...INTERN, "x-schulos-extern": "1" }, [200]);

if (mode === "keiner") {
  for (const p of [...blocked, ...publicPages, "/anmeldung", "/api/schule/logo"]) await expectStatus("extern gesperrt", p, EXTERN, [403]);
}

if (mode === "alles") {
  await expectStatus("extern Login", "/login", EXTERN, [200]);
  // ein mitgeschickter Header darf auch hier nicht zur Sperre in der App führen (Caddy verwirft ihn)
  await expectStatus("extern, gefälschter X-SchulOS-Extern", "/login", { ...EXTERN, "x-schulos-extern": "1" }, [200]);
}

if (mode === "oeffentliche-seiten") {
  for (const p of blocked) await expectStatus("extern gesperrt", p, EXTERN, [403]);
  // links vorangestellte interne Adresse hilft nicht (trusted_proxies_strict liest von rechts)
  await expectStatus("extern, X-Forwarded-For mit interner Adresse vorn", "/login", { "x-forwarded-for": "10.1.2.3, 203.0.113.7" }, [403]);
  // gefälschter Header mit anderem Wert ändert nichts
  await expectStatus("extern, X-SchulOS-Extern: 0", "/login", { ...EXTERN, "x-schulos-extern": "0" }, [403]);
  // Prefetch-Header umgeht die App-Prüfung nicht (eigener Matcher in src/proxy.ts) – und Caddy sperrt ohnehin
  await expectStatus("extern, Prefetch", "/verwaltung", { ...EXTERN, purpose: "prefetch", "next-router-prefetch": "1" }, [403]);

  for (const p of publicPages) await expectStatus("extern öffentlich", p, EXTERN, [200]);
  // Schulanmeldung: 200 bei eingeschaltetem Modul, sonst 404; Logo: 404 ohne hochgeladenes Logo – nie die Sperre
  await expectStatus("extern Logo", "/api/schule/logo", EXTERN, [200, 404]);
  await expectStatus("extern Schulanmeldung", "/anmeldung", EXTERN, [200, 404]);

  // Seiten-Assets von außen: eine Datei aus /_next/static, die das Impressum lädt
  const imp = await get("/impressum", EXTERN);
  const asset = /\/_next\/static\/[^"'\s)]+\.(?:js|css|woff2)/.exec(imp.body)?.[0];
  if (!asset) {
    console.log("✗ extern: keine /_next/static-Datei im Impressum gefunden");
    failed++;
  } else await expectStatus("extern Asset", asset, EXTERN, [200]);
  // ohne Sitzung: auch mit Cookie kommt von außen keine Startseite
  await expectStatus("extern mit Cookie", "/", { ...EXTERN, cookie: "better-auth.session_token=x" }, [403]);

  // Pfad-Tricks: Caddy (400/403) oder die App (403) – nie die Seite dahinter
  for (const p of [
    "/anmeldung/../login",
    "/anmeldung/%2e%2e/login",
    "/anmeldung/%2E%2E/verwaltung",
    "/anmeldung%2f..%2flogin",
    "/anmeldung/%2f..%2f..%2fapi%2fverwaltung%2fanmeldung-export",
    "/anmeldung/..%5c..%5clogin",
    "/_next/static/../../login",
    "//login",
    "/anmeldung//../login",
    "/ANMELDUNG",
    "/Login",
    "/IMPRESSUM",
    "/api/schule/logo/../../verwaltung",
  ])
    await expectStatus("extern Pfad-Trick", p, EXTERN, [400, 403]);
}

if (failed) {
  console.error(`Außenzugang (${mode}): ${failed} Prüfung(en) fehlgeschlagen`);
  process.exit(1);
}
console.log(`Außenzugang (${mode}) bestanden`);
