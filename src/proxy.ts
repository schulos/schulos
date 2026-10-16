import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@schulos/server/security-headers";
import { maintenancePage, readMaintenance } from "@/core/backup/maintenance";
import { EXTERNAL_AUTH_API, EXTERNAL_BLOCKED_TEXT, externalPathAllowed, externalZone, forwardedHeaders, loginPath } from "@/core/external-access";
import { externalActionAllowed } from "@/core/public-action-ids";
import { NO_STORE_HEADER, noStorePath } from "@/core/no-store";
import { isPublicPath } from "@/core/public-paths";
import { CROWDSEC_BLOCKED_TEXT, crowdsecBlocked, crowdsecOnlyRequest } from "@/core/crowdsec";

/**
 * Dateien, die von außen ohne CSP durchgehen (GATE-4c, Security N1): nur echte statische Pfade – nicht jede Adresse mit
 * Dateiendung (`/anmeldung/x.js` träfe sonst eine Seite ohne CSP). Im Schulnetz nimmt der erste Matcher unten solche Pfade
 * weiterhin ganz aus (Seiten prüfen die Sitzung selbst).
 */
const STATIC_ASSET = /^\/(?:_next\/static\/|_next\/image$|favicon\.ico$|icon\.png$)/;

const blocked = () => new NextResponse(EXTERNAL_BLOCKED_TEXT, { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // G4E-O13: nur wegen der CrowdSec-Sperre hier (Prefetch, Dateiendung im Schulnetz) – sonst unverändert durch wie früher
  const crowdsecOnly = crowdsecOnlyRequest(pathname, req.headers);
  // Wiederherstellung läuft (B-27): alles außer dem Healthcheck mit 503 beantworten
  const maintenance = pathname.startsWith("/api/health") || crowdsecOnly ? null : readMaintenance();
  if (maintenance) return new NextResponse(maintenancePage(maintenance), { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "30" } });
  // SEC-15 (optional): Sperren von CrowdSec – Absender laut Caddy (X-Forwarded-For = {client_ip}); ohne Einstellung nichts
  if (crowdsecBlocked(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()))
    return new NextResponse(CROWDSEC_BLOCKED_TEXT, { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (crowdsecOnly) return NextResponse.next();

  // Außenzugang (P4-40/P4-40b, src/core/external-access.ts, SICHERHEIT.md S35/S27): die Zone kommt aus den Kennzeichen von
  // Caddy. „oeffentlich“ (jeder unbekannte Wert) → nur die Allowlist, ohne Sitzung – zweite Linie hinter Caddy.
  const zone = externalZone(req.headers);
  if (zone === "oeffentlich" && !externalPathAllowed(pathname)) return blocked();
  // GATE-4c: Server Actions von außen nur aus den öffentlichen Action-Dateien – Next würde eine fremde Action-ID an den Worker
  // ihrer Seite (z. B. /login) weiterleiten (src/core/public-action-ids.ts)
  if (zone === "oeffentlich" && !externalActionAllowed(req.headers.get("next-action"))) return blocked();
  // Mit Gerätezertifikat durchgelassen: Seiten ohne Anmeldung nur aus der Allowlist bzw. Anmeldung/zweiter Faktor – Monitore,
  // Healthcheck usw. bleiben im Schulnetz. Ob das Zertifikat freigegeben ist, prüft die Sitzung (src/core/device-certs).
  if (zone === "geraet" && isPublicPath(pathname) && !externalPathAllowed(pathname) && !loginPath(pathname)) return blocked();
  // Auth-API von außen nur Anmelden/Abmelden/Sitzung lesen (EXTERNAL_AUTH_API)
  if ((zone === "alles" || zone === "geraet") && pathname.startsWith("/api/auth/") && !EXTERNAL_AUTH_API.has(pathname)) return blocked();
  // nur geprüfte Kennzeichen weiterreichen; von außen ohne Freigabe ohne Cookie/Authorization
  const forwarded = forwardedHeaders(req.headers, zone);
  const baseHeaders = forwarded ?? req.headers;
  const pass = () => (forwarded ? NextResponse.next({ request: { headers: forwarded } }) : NextResponse.next());
  // statische Dateien (nur für die Kennzeichnung im Matcher) – ohne Sitzung weiterreichen; im Schulnetz läuft der Proxy für
  // sie gar nicht (erster Matcher), Datei-Routen unter /api prüfen die Sitzung selbst
  if (zone === "oeffentlich" && !isPublicPath(pathname)) return pass();
  if (zone !== "intern" && STATIC_ASSET.test(pathname)) return pass();

  // Optimistischer Schutz: ohne Session-Cookie direkt zum Login. Die echte Prüfung macht requireUser() im Shell-Layout.
  if (!isPublicPath(pathname) && !getSessionCookie(req)) {
    // API: 401 statt Umleitung – Downloads/fetch sollen „nicht angemeldet“ erkennen, nicht die Anmeldeseite bekommen (B-54)
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // API-Antworten ohne Seiten-CSP: Datei-Routen (Profilbild, Dateien, Aufgaben, Elternbriefe …) setzen ihre eigene mit
  // `sandbox` (S8) – eine hier gesetzte CSP hat sie bisher überschrieben (aufgefallen in P4-06 am Header-Test der Logo-Route)
  if (pathname.startsWith("/api/")) {
    const res = pass();
    // P5-12: Notenbuch-Antworten nie zwischenspeichern (src/core/no-store.ts)
    if (noStorePath(pathname)) res.headers.set("Cache-Control", NO_STORE_HEADER);
    return res;
  }

  // CSP mit frischem Nonce je Anfrage (Next setzt ihn beim Rendern in seine Skripte, siehe docs/…/content-security-policy.md)
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(baseHeaders);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  // P5-12: Notenbuch-Seiten (auch RSC-Antworten und Server Actions) nie zwischenspeichern – Browser, Proxy, künftiger SW
  if (noStorePath(pathname)) res.headers.set("Cache-Control", NO_STORE_HEADER);
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webp|jpg|css|js|woff2?)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    // P4-40: von außen gekennzeichnete Anfragen immer – auch statische Dateien und Prefetches, sonst ließe sich die Allowlist
    // mit einem Prefetch-Header oder einer Dateiendung (/api/…/x.png) umgehen
    { source: "/:path*", has: [{ type: "header", key: "x-schulos-extern" }] },
    // P4-40b: ein mitgeschickter Geräte-Header wird immer entfernt bzw. durch den geprüften Wert ersetzt
    { source: "/:path*", has: [{ type: "header", key: "x-schulos-geraet" }] },
    // G4E-O13: die CrowdSec-Sperre gilt auch im Schulnetz für Prefetches und Pfade mit Dateiendung (nur Next-Build-Dateien nicht)
    { source: "/:path*", has: [{ type: "header", key: "next-router-prefetch" }] },
    { source: "/:path*", has: [{ type: "header", key: "purpose", value: "prefetch" }] },
    { source: "/((?!_next/static|_next/image|favicon.ico).*\\.(?:png|svg|ico|webp|jpg|css|js|woff2?))" },
  ],
};
