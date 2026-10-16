// Smoketest gegen eine laufende Instanz (B-18): Health, Login-Seite mit CSP, Anmeldung über die Auth-API,
// Startseite mit Sitzung, Live-Verbindung (SSE kommt ohne Pufferung durch den Proxy).
// Aufruf: node scripts/smoke.mjs <basis-url> [benutzer] [passwort] [--insecure]   (Vorgabe: lea.schaefer / schulos)
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (process.argv.includes("--insecure")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // eigene CA (Caddy internal)
const base = (args[0] ?? "https://localhost").replace(/\/$/, "");
const user = args[1] ?? "lea.schaefer";
const password = args[2] ?? "schulos";

const step = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` – ${detail}` : ""}`);
  if (!ok) process.exit(1);
};

// 1. Health (Start inkl. Migration und ggf. Demo-Seed abwarten)
let health;
for (let i = 0; i < 90; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) {
      health = await r.json();
      break;
    }
  } catch {
    // noch nicht erreichbar
  }
  await new Promise((r) => setTimeout(r, 2000));
}
step("Health", health?.ok === true, JSON.stringify(health));

// 2. Login-Seite
const login = await fetch(`${base}/login`);
const csp = login.headers.get("content-security-policy") ?? "";
step("Login-Seite", login.status === 200 && /nonce-/.test(csp), `HTTP ${login.status}, CSP ${csp ? "mit Nonce" : "fehlt"}`);

// 3. Anmeldung über die Auth-API
const signIn = await fetch(`${base}/api/auth/sign-in/username`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ username: user, password }),
});
const cookies = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const body = await signIn.json().catch(() => ({}));
step("Anmeldung", signIn.status === 200 && cookies.includes("session_token"), `HTTP ${signIn.status} ${body.user?.name ?? body.message ?? ""}`);
const secure = signIn.headers.getSetCookie().every((c) => !base.startsWith("https://") || /;\s*Secure/i.test(c));
step("Cookies Secure hinter HTTPS", secure);

// 4. Startseite mit Sitzung
const home = await fetch(`${base}/`, { headers: { cookie: cookies }, redirect: "manual" });
const html = await home.text();
const firstName = String(body.user?.name ?? "").split(" ")[0];
step("Startseite angemeldet", home.status === 200 && html.includes(firstName), `HTTP ${home.status}`);
// fetch bittet um gzip/br/zstd; komprimieren muss Caddy, die App tut es nicht (B-56) – nur hinter dem Proxy prüfbar
if (base.startsWith("https://")) {
  const enc = home.headers.get("content-encoding") ?? "";
  step("Kompression durch den Proxy", /zstd|gzip/.test(enc), enc || "unkomprimiert");
}

// 5. Live-Verbindung: erstes Ereignis muss sofort ankommen (flush_interval -1)
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 5000);
let sse = "";
try {
  const r = await fetch(`${base}/api/gong/stream`, { headers: { cookie: cookies }, signal: ctrl.signal });
  const reader = r.body.getReader();
  while (!sse.includes("event: hello")) {
    const { value, done } = await reader.read();
    if (done) break;
    sse += new TextDecoder().decode(value);
  }
  ctrl.abort();
} catch {
  // Abbruch nach Timeout
}
clearTimeout(timer);
step("Live-Verbindung (SSE)", sse.includes("event: hello"), sse ? "erstes Ereignis empfangen" : "nichts innerhalb von 5 s");
console.log("Smoketest bestanden");
process.exit(0);
