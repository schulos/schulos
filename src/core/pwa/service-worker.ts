// PWA ohne Push (P4-73): Quelltext des Service Workers, ausgeliefert von src/app/sw.js/route.ts. Rein, damit Vitest genau
// diesen Text auswertet (service-worker.test.ts) – keine zweite Fassung der Regeln.
//
// Regeln (docs/SICHERHEIT.md S63, Q-5A-8, Q-4E-25):
//   · Zwischengespeichert werden **nur** statische Programmdateien: `/_next/static/…` (Dateiname mit Inhalts-Hash) und das
//     SchulOS-Symbol – nie HTML, nie RSC-Antworten, nie API-Antworten, nie Server Actions, nie Antworten mit `no-store`/`private`.
//   · Pfade aus `src/core/no-store.ts` (Notenbuch) fasst der Service Worker gar nicht an: kein respondWith, nur Netzwerk.
//   · Seitenaufrufe gehen immer ans Netz; nur wenn das scheitert, zeigt er einen festen Hinweis „Keine Verbindung“ (ohne Daten).
//   · Neue Fassung: installiert sofort, löscht beim Aktivieren alle älteren SchulOS-Caches; Nachricht `clear` (Abmelden) leert alles.
import { NO_STORE_PREFIXES } from "@/core/no-store";

/** Präfix aller Caches des Service Workers – Abmelden löscht alles mit diesem Präfix. */
export const PWA_CACHE_PREFIX = "schulos-";

/** statische Dateien (ohne Personenbezug), die zwischengespeichert werden dürfen */
export const STATIC_PREFIXES = ["/_next/static/"] as const;
export const STATIC_EXACT = ["/icon.png", "/favicon.ico"] as const;

/** fester Hinweis bei fehlender Verbindung – enthält bewusst keine Inhalte, nur Text (keine Skripte) */
export const OFFLINE_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keine Verbindung · SchulOS</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f4f5f7; color: #14181f; }
main { max-width: 28rem; margin: 1rem; padding: 2rem; border-radius: 1rem; border: 1px solid #c9ced6; background: #fff; }
h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
p { line-height: 1.5; margin: 0 0 1rem; color: #5b6472; }
a { display: inline-block; padding: .6rem 1rem; border-radius: .75rem; background: #0e7c66; color: #fff; font-weight: 600; text-decoration: none; }
a:focus-visible { outline: 2px solid #0e7c66; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  body { background: #0f1217; color: #eceff4; }
  main { background: #171b22; border-color: #3a4150; }
  p { color: #9aa3b2; }
}
</style>
</head>
<body>
<main>
<h1>Keine Verbindung</h1>
<p>SchulOS ist gerade nicht erreichbar – das Gerät ist offline oder der Schulserver antwortet nicht. Inhalte werden auf diesem Gerät nicht gespeichert und sind deshalb ohne Verbindung nicht verfügbar.</p>
<a href="">Erneut versuchen</a>
</main>
</body>
</html>`;

/**
 * Quelltext des Service Workers. `version` (Build-ID) steckt im Cache-Namen: jede neue Fassung räumt die alten Caches weg.
 * Bewusst einfaches JavaScript ohne Abhängigkeiten und ohne reguläre Ausdrücke.
 */
export function serviceWorkerSource(version: string): string {
  const v = JSON.stringify(String(version).slice(0, 64));
  return `// SchulOS Service Worker (P4-73) – erzeugt von src/core/pwa/service-worker.ts
"use strict";
const PREFIX = ${JSON.stringify(PWA_CACHE_PREFIX)};
const CACHE = PREFIX + "static-" + ${v};
const NO_STORE = ${JSON.stringify(NO_STORE_PREFIXES)};
const STATIC_PREFIXES = ${JSON.stringify(STATIC_PREFIXES)};
const STATIC_EXACT = ${JSON.stringify(STATIC_EXACT)};
const OFFLINE_HTML = ${JSON.stringify(OFFLINE_HTML)};

function noStorePath(path) {
  return NO_STORE.some(function (p) { return path === p || path.indexOf(p + "/") === 0; });
}

/** "network" = nicht anfassen · "navigate" = Netz, bei Fehler Hinweis · "static" = Cache zuerst */
function decide(req) {
  const u = new URL(req.url);
  if (req.method !== "GET") return "network";
  if (u.origin !== self.location.origin) return "network";
  if (noStorePath(u.pathname)) return "network";
  if (u.pathname === "/api" || u.pathname.indexOf("/api/") === 0) return "network";
  if (req.headers.get("next-action") || req.headers.get("rsc") || req.headers.get("next-router-state-tree") || u.searchParams.has("_rsc")) return "network";
  if (req.mode === "navigate") return "navigate";
  if (STATIC_EXACT.indexOf(u.pathname) >= 0) return "static";
  if (STATIC_PREFIXES.some(function (p) { return u.pathname.indexOf(p) === 0; })) return "static";
  return "network";
}

/** Nur vollständige, eigene, öffentlich cachebare Antworten ablegen. */
function storable(res) {
  if (!res || !res.ok || res.status !== 200 || res.type !== "basic") return false;
  const cc = (res.headers.get("cache-control") || "").toLowerCase();
  return cc.indexOf("no-store") < 0 && cc.indexOf("private") < 0;
}

function offline() {
  return new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function clearAll() {
  return caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0; }).map(function (k) { return caches.delete(k); }));
  });
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "clear") event.waitUntil(clearAll());
});

self.addEventListener("fetch", function (event) {
  const req = event.request;
  const how = decide(req);
  if (how === "network") return;
  if (how === "navigate") {
    event.respondWith(fetch(req).catch(offline));
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (storable(res)) cache.put(req, res.clone());
          return res;
        });
      });
    })
  );
});
`;
}
