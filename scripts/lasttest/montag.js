// Lasttest „Montag 7:40“ (B-50a) für k6 – gestartet von scripts/lasttest.sh gegen ein Demo-Hauptsystem.
// Alle kommen innerhalb weniger Minuten: anmelden (Formular wie im Browser ohne JavaScript, also über die Server Action –
// nicht über /api/auth, das per IP begrenzt ist), dann je Rolle typische Seiten mit Denkpausen, angemeldet bleiben.
// Nur lesend, damit Läufe vergleichbar bleiben. Ganze Seiten (HTML) statt Client-Navigation (RSC) – etwas teurer als echt.
// Umgebung: BASE_URL, KONTEN (Datei mit JSON [{u, r}]) bzw. KONTEN_JSON, NUTZER (300), RAMPE (2m), DAUER (10m), PASSWORT (schulos)
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import http from "k6/http";

const BASE = __ENV.BASE_URL || "https://demo.schulos.test";
const USERS = Number(__ENV.NUTZER || 300);
const PASSWORD = __ENV.PASSWORT || "schulos";

// Anteile wie an einer Gesamtschule morgens: vor allem Schüler:innen, dazu Lehrkräfte und einige Eltern
const SHARES = { schueler: 0.65, lehrkraft: 0.2, eltern: 0.15 };
const PAGES = {
  schueler: [
    ["heute", "/"],
    ["stundenplan", "/stundenplan"],
    ["vertretungen", "/stundenplan/vertretungen"],
    ["aufgaben", "/aufgaben"],
    ["messenger", "/messenger"],
    ["dateien", "/dateien"],
    ["news", "/news"],
  ],
  lehrkraft: [
    ["heute", "/"],
    ["vertretungen", "/stundenplan/vertretungen"],
    ["stundenplan", "/stundenplan"],
    ["klassenbuch", "/klassenbuch"],
    ["aufgaben", "/aufgaben"],
    ["dateien", "/dateien"],
    ["messenger", "/messenger"],
  ],
  eltern: [
    ["heute", "/"],
    ["elternbriefe", "/elternbriefe"],
    ["stundenplan", "/stundenplan"],
    ["abwesenheiten", "/abwesenheiten"],
    ["news", "/news"],
  ],
};
const NAMES = ["anmeldeseite", "anmeldung", ...new Set(Object.values(PAGES).flatMap((p) => p.map(([n]) => n)))];

const accounts = new SharedArray("konten", () => {
  const all = JSON.parse(__ENV.KONTEN_JSON || open(__ENV.KONTEN || "./konten.json"));
  const picked = [];
  for (const [role, share] of Object.entries(SHARES)) {
    picked.push(...all.filter((a) => a.r === role).slice(0, Math.ceil(USERS * share)));
  }
  // gemischt nach Rolle (sonst kämen erst alle Schüler:innen, dann alle Lehrkräfte)
  return picked.map((a, i) => ({ a, k: (i * 7919) % picked.length })).sort((x, y) => x.k - y.k).map((x) => x.a);
});

export const options = {
  insecureSkipTLSVerify: true,
  // angemeldet bleiben: k6 leert das Cookie-Glas sonst bei jeder Iteration
  noCookiesReset: true,
  scenarios: {
    montag: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMPE || "2m", target: USERS },
        { duration: __ENV.DAUER || "10m", target: USERS },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  // lockere Grenzen – vor allem, damit k6 die Werte je Seite ausweist; der Lauf scheitert nur an Fehlern
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    ...Object.fromEntries(NAMES.flatMap((n) => [[`http_req_duration{name:${n}}`, ["p(95)<10000"]], [`http_reqs{name:${n}}`, ["count>=0"]]])),
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "max"],
};

function multipart(fields) {
  const boundary = "----schulos" + Math.random().toString(16).slice(2);
  let body = "";
  for (const [k, v] of Object.entries(fields)) body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  return { body: body + `--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` };
}

function login(account) {
  const page = http.get(`${BASE}/login`, { tags: { name: "anmeldeseite" } });
  const fields = {};
  for (const input of page.html().find('form input[type="hidden"]').toArray()) fields[input.attr("name")] = input.attr("value") || "";
  fields.username = account.u;
  fields.password = PASSWORD;
  const { body, type } = multipart(fields);
  const res = http.post(`${BASE}/login`, body, {
    headers: { "content-type": type, origin: BASE },
    redirects: 0,
    tags: { name: "anmeldung" },
  });
  return check(res, {
    "Anmeldung leitet weiter": (r) => r.status === 303,
    "Sitzungs-Cookie gesetzt": (r) => String(r.headers["Set-Cookie"] || "").includes("session_token"),
  });
}

let loggedIn = false;

export default function montag() {
  const account = accounts[(exec.vu.idInTest - 1) % accounts.length];
  if (!loggedIn) {
    loggedIn = login(account);
    if (!loggedIn) {
      sleep(10);
      return;
    }
  }
  for (const [name, path] of PAGES[account.r]) {
    const res = http.get(`${BASE}${path}`, { tags: { name } });
    const ok = check(res, { "Seite lädt": (r) => r.status === 200 && !r.url.includes("/login") });
    if (!ok && res.url.includes("/login")) loggedIn = false;
    sleep(2 + Math.random() * 4);
  }
  sleep(10 + Math.random() * 10);
}

export function handleSummary(data) {
  const lines = [`${data.metrics.http_reqs.values.count} Anfragen, Fehlerquote ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)} %`];
  for (const n of NAMES) {
    const m = data.metrics[`http_req_duration{name:${n}}`];
    if (m && m.values.max > 0) lines.push(`  ${n.padEnd(14)} p95 ${Math.round(m.values["p(95)"])} ms, Mittel ${Math.round(m.values.avg)} ms`);
  }
  for (const c of data.root_group.checks) if (c.fails > 0) lines.push(`  Prüfung „${c.name}“: ${c.fails} von ${c.passes + c.fails} fehlgeschlagen`);
  return { stdout: lines.join("\n") + "\n", [__ENV.ZUSAMMENFASSUNG || "/out/summary.json"]: JSON.stringify(data) };
}
