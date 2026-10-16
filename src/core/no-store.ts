// Pfade, deren Antworten nie zwischengespeichert werden dürfen – weder im Browser-Cache noch in einem Proxy noch in einem
// künftigen Service Worker/Offline-Cache (P5-12, Notenbuch: PHASE5-NOTENBUCH §2 „nichts lokal“, Vordruck/Privatgeräte).
// `src/proxy.ts` setzt dafür `Cache-Control: private, no-store`. **P4-73 (PWA):** Der Service Worker (src/core/pwa/
// service-worker.ts) bekommt diese Liste eingebettet und fasst solche Anfragen nicht an (nur Netzwerk, nichts ablegen) – Liste hier
// pflegen, nicht duplizieren. Eine Offline-Eingabe
// fürs Notenbuch kommt nur verschlüsselt und nur auf Dienstgeräten (P5-20), nie über den allgemeinen SW-Cache.

export const NO_STORE_PREFIXES = ["/notenbuch", "/api/notenbuch"] as const;

export const NO_STORE_HEADER = "private, no-store, max-age=0";

/** Gehört der Pfad zu einem Bereich ohne Zwischenspeicher? (`/notenbuchx` zählt nicht.) */
export function noStorePath(pathname: string): boolean {
  return NO_STORE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
