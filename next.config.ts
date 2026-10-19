import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "@schulos/server/security-headers";

/** Alte Verwaltungspfade der Stundenplanung → neue Pfade unter /planung (SP-03) */
const PLANUNG_REDIRECTS: [string, string][] = [
  ["/verwaltung/stundenplan/solver", "/planung/solver"],
  ["/verwaltung/stundenplan", "/planung/stundenplan"],
  ["/verwaltung/unterricht/zeitwuensche", "/planung/zeitwuensche"],
  ["/verwaltung/unterricht", "/planung/unterricht"],
  ["/verwaltung/vertretungen", "/planung/vertretungen"],
  ["/verwaltung/aufsichten", "/planung/aufsichten"],
];

const nextConfig: NextConfig = {
  // Container-Image (Dockerfile): eigenständiger Server unter .next/standalone
  output: "standalone",
  // Der Tracer folgt path.join(cwd, ".data", …) – lokale Daten dürfen nie ins Image
  outputFileTracingExcludes: { "**": [".data/**", "e2e/**", "docs/**", "scripts/**"] },
  // PGlite bringt eigene WASM-Dateien mit und darf nicht gebündelt werden.
  // yjs (Texte, P3-11) nur einmal laden: Route-Handler und Server Actions liegen in getrennten Bundle-Schichten – zwei
  // yjs-Instanzen würden sich nicht als dasselbe Dokument erkennen (globalThis-Speicher in src/modules/texte/live.ts).
  serverExternalPackages: ["@electric-sql/pglite", "yjs"],
  poweredByHeader: false,
  // Komprimieren macht Caddy (compose.yaml, Snippet „kompression“): gzip kostete auf Heute ~18 % der CPU des einen
  // Node-Prozesses, der unter Last der Engpass ist (B-56, docs/LASTTEST.md). Ohne Caddy (next start, E2E) unkomprimiert.
  compress: false,
  // Reproduzierbarer Bau (B-47): fester Build-Name aus dem Commit statt Zufall (Dockerfile, ARG SCHULOS_BUILD_ID)
  generateBuildId: async () => process.env.SCHULOS_BUILD_ID || null,
  // Feste Sicherheits-Header; die CSP mit Nonce setzt src/proxy.ts je Anfrage
  async headers() {
    return [
      { source: "/:path*", headers: STATIC_SECURITY_HEADERS },
      // Schulanmeldung (P4-34): Adressen mit geheimem Token – nie als Referrer weitergeben, nicht in Suchmaschinen
      {
        source: "/anmeldung/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  // SP-03 (docs/STUNDENPLAN-UMBAU.md §2.3, Q-SP-7): die Planungsseiten sind aus der Verwaltung nach /planung umgezogen. Die alten
  // Pfade leiten dauerhaft weiter (Lesezeichen, Monitore, Links in älteren Gongs); 307, Query bleibt erhalten. Spezifische zuerst.
  async redirects() {
    return PLANUNG_REDIRECTS.map(([from, to]) => ({ source: `${from}/:path*`, destination: `${to}/:path*`, permanent: false }));
  },
  experimental: {
    // Aufgaben-Abgaben mit Dateien laufen über Server Actions (Limit je Datei: 25 MB im Service).
    serverActions: { bodySizeLimit: "30mb" },
    // src/proxy.ts läuft auch für Uploads und Server Actions; Next puffert den Body dann nur bis zu dieser Grenze und
    // schneidet den Rest still ab (Standard 10 MB). Passend zu bodySizeLimit, damit 25-MB-Dateien ankommen (SEC-05).
    proxyClientMaxBodySize: "30mb",
  },
};

export default nextConfig;
