import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@schulos/server/security-headers";

// Ohne Anmeldung erreichbar: Login (inkl. zweiter Faktor), Auth-API, Healthcheck, Kopplungs-API (der Code ist der Zugang) und
// Agent-API (Zugang über den Agent-Token), interne API der Kommandozeile (Token aus dem App-Geheimnis, nur 127.0.0.1).
const PUBLIC = /^\/(login|api\/auth|api\/health|api\/pairing\/|api\/agent\/|api\/intern\/)/;

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Optimistischer Schutz: ohne Sitzungs-Cookie direkt zum Login. Die echte Prüfung macht requireUser() im Layout.
  if (!PUBLIC.test(pathname) && !getSessionCookie(req, { cookiePrefix: "schulos-backup" })) {
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
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
  ],
};
