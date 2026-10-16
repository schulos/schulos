// Prüfungen Gerätezertifikate (P4-40b) gegen den laufenden Stack – aufgerufen von scripts/geraetezertifikat-test.sh.
// „Von außen“ wie im Außenzugang-Test per X-Forwarded-For (203.0.113.7); Client-Zertifikate aus dem Ordner der Test-CA.
// Aufruf: node scripts/geraetezertifikat-test.mjs <basis-url> <keiner|alles> <ordner> [--insecure]
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const insecure = process.argv.includes("--insecure");
const base = new URL(args[0] ?? "https://localhost:8443");
const mode = args[1];
const dir = args[2];
if (!["keiner", "alles"].includes(mode ?? "") || !dir) {
  console.error("Aufruf: node scripts/geraetezertifikat-test.mjs <basis-url> <keiner|alles> <ordner> [--insecure]");
  process.exit(2);
}

const EXTERN = { "x-forwarded-for": "203.0.113.7" };
const INTERN = { "x-forwarded-for": "10.1.2.3" };
const identity = (name) => ({ cert: readFileSync(path.join(dir, `${name}.crt`)), key: readFileSync(path.join(dir, `${name}.key`)) });
const fingerprint = (name) => new X509Certificate(readFileSync(path.join(dir, `${name}.crt`))).fingerprint256.replace(/:/g, "").toLowerCase();

/** Anfrage mit optionalem Client-Zertifikat; Status, Text, Cookies – oder { error } bei abgebrochenem Handshake */
function request(rawPath, { headers = {}, method = "GET", body, client } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        host: base.hostname,
        port: base.port,
        path: rawPath,
        method,
        // eigene Verbindung je Anfrage – sonst käme ein Zertifikat über eine wiederverwendete TLS-Sitzung mit
        agent: false,
        rejectUnauthorized: !insecure,
        servername: base.hostname,
        headers: { host: base.host, ...(data ? { "content-type": "application/json", origin: base.origin, "content-length": Buffer.byteLength(data) } : {}), ...headers },
        ...(client ? identity(client) : {}),
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, cookies: (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ") }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(15_000, () => req.destroy(new Error("Zeitüberschreitung")));
    req.end(data);
  });
}

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} [${mode}] ${label}${detail ? ` – ${detail}` : ""}`);
  if (!ok) failed++;
}
async function expectStatus(label, rawPath, opts, allowed) {
  const r = await request(rawPath, opts);
  check(label, allowed.includes(r.status), `${rawPath} → ${r.status || r.error}`);
  return r;
}
/** Anmeldung über die Auth-API; ok = Sitzungs-Cookie bekommen */
let ipCounter = 10;
async function signIn(label, username, opts, expectOk) {
  // je Anmeldung eine andere Adresse von außen – Better-Auth begrenzt /sign-in/* auf 10 je Minute und IP
  const headers = opts.headers["x-forwarded-for"] === EXTERN["x-forwarded-for"] ? { ...opts.headers, "x-forwarded-for": `203.0.113.${++ipCounter}` } : opts.headers;
  const r = await request("/api/auth/sign-in/username", { ...opts, headers, method: "POST", body: { username, password: "schulos" } });
  const ok = r.status === 200 && r.cookies.includes("session_token");
  check(`${label}: Anmeldung ${username} ${expectOk ? "möglich" : "abgelehnt"}`, ok === expectOk, `HTTP ${r.status || r.error}`);
  return r;
}
/** TLS-Handshake mit ungültigem Zertifikat muss scheitern (Verbindungsfehler) – nie eine Seite liefern */
async function expectHandshakeRejected(label, client) {
  const r = await request("/login", { headers: EXTERN, client });
  check(`${label}: Handshake abgelehnt`, r.status === 0, r.error ?? `HTTP ${r.status}`);
}

// Stack wurde gerade neu erstellt – warten, bis Caddy und App antworten
for (let i = 0; ; i++) {
  if ((await request("/login", { headers: INTERN })).status === 200) break;
  if (i >= 90) {
    console.error("Stack antwortet nicht");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const gueltig = { headers: EXTERN, client: "gueltig" };
const gesperrt = { headers: EXTERN, client: "gesperrt" };
const unbekannt = { headers: EXTERN, client: "unbekannt" };

// Schulnetz: unverändert, gefälschte Kennzeichen wirkungslos (Caddy verwirft sie)
await signIn("intern", "admin", { headers: INTERN }, true);
await signIn("intern, gefälschtes X-SchulOS-Extern: alles", "admin", { headers: { ...INTERN, "x-schulos-extern": "alles" } }, true);

// ungültige Zertifikate: TLS bricht ab (verify_if_given) – in jedem Modus
await expectHandshakeRejected("abgelaufen", "abgelaufen");
await expectHandshakeRejected("fremde CA", "fremdgeraet");

// gültiges, freigegebenes Zertifikat: Lehrkraft und Eltern ja, Admin nein (Vorgabe)
const lk = await signIn("gültig", "jana.brandt", gueltig, true);
await expectStatus("gültig, Startseite mit Sitzung", "/", { headers: { ...EXTERN, cookie: lk.cookies }, client: "gueltig" }, [200]);
await signIn("gültig", "daniela.schaefer", gueltig, true);
await signIn("gültig", "admin", gueltig, false);
// Seiten ohne Anmeldung (Healthcheck, Monitore): das Zertifikat öffnet nichts, was ohne Zertifikat zu ist, und sperrt nichts,
// was ohne offen ist – „keiner“: zu (Zone geraet: nur Allowlist + Login), „alles“: ganz SchulOS von außen, also offen wie ohne
// Zertifikat (SICHERHEIT.md S27, INSTALLATION.md §5b/§5c). Geprüft wird deshalb auch der Weg ohne Zertifikat.
const ohneAnmeldung = mode === "keiner" ? [403] : [200];
for (const [label, p] of [["Healthcheck", "/api/health"], ["Monitor", "/monitor/demo-foyer-lindenhof-2026"]]) {
  await expectStatus(`gültig, ${label}`, p, gueltig, ohneAnmeldung);
  await expectStatus(`ohne Zertifikat, ${label}`, p, { headers: EXTERN }, ohneAnmeldung);
}
// Sitzung der Lehrkraft ohne Zertifikat weiterbenutzen → im Modus „keiner“ sperrt Caddy, bei „alles“ die App
await expectStatus("Sitzung ohne Zertifikat", "/", { headers: { ...EXTERN, cookie: lk.cookies } }, mode === "keiner" ? [403] : [307]);
await expectStatus("Sitzung ohne Zertifikat, API", "/api/gong/stream", { headers: { ...EXTERN, cookie: lk.cookies } }, [403]);

// gesperrt / nicht freigegeben: TLS geht, aber keine Anmeldung für Personal
await signIn("gesperrt", "jana.brandt", gesperrt, false);
await signIn("unbekannt", "jana.brandt", unbekannt, false);
// Eltern: mit gesperrtem Gerät im Modus „keiner“ nicht (durchgelassen nur wegen des Zertifikats), bei „alles“ wie ohne
await signIn("gesperrt", "daniela.schaefer", gesperrt, mode === "alles");

// gefälschte Kennzeichen ohne Zertifikat: der Fingerabdruck eines gültigen Geräts im Header hilft nicht
const forged = { headers: { ...EXTERN, "x-schulos-extern": "geraet", "x-schulos-geraet": fingerprint("gueltig") } };
if (mode === "keiner") {
  await expectStatus("gefälscht, Login-Seite", "/login", forged, [403]);
  await expectStatus("gefälscht, Anmeldung", "/api/auth/sign-in/username", { ...forged, method: "POST", body: { username: "jana.brandt", password: "schulos" } }, [403]);
} else {
  // Modus „alles“: ohne Zertifikat ist Personal draußen (Pflicht, sobald die CA eingerichtet ist), Eltern nicht
  await signIn("gefälscht", "jana.brandt", forged, false);
  await signIn("ohne Zertifikat", "jana.brandt", { headers: EXTERN }, false);
  await signIn("ohne Zertifikat", "daniela.schaefer", { headers: EXTERN }, true);
  await signIn("ohne Zertifikat", "admin", { headers: EXTERN }, false);
}

if (failed) {
  console.error(`Gerätezertifikate (${mode}): ${failed} Prüfung(en) fehlgeschlagen`);
  process.exit(1);
}
console.log(`Gerätezertifikate (${mode}) bestanden`);
