/**
 * Sicherheits-Header (B-12, DATENSCHUTZ.md §5 „Header“). Die CSP setzt der Proxy je Anfrage mit frischem Nonce;
 * die festen Header kommen aus next.config.ts. Rein, damit Tests sie prüfen können.
 */
export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic': von Next mit Nonce geladene Skripte dürfen weitere laden; ohne Inline-Skripte von außen
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // style-Attribute (Fachfarben, Schulfarbe) brauchen 'unsafe-inline' – Nonces gelten nur für <style>/<script>
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    // Dateivorschau zeigt eigene Dateien im iframe
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
  ].join("; ");
}

/** Feste Header für alle Antworten. HSTS wirkt nur über HTTPS – Browser ignorieren ihn bei http (Dev, E2E). */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=(), browsing-topics=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];
