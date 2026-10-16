// Außenzugang (P4-40, INSTALLATION.md „Außenzugang“, SICHERHEIT.md S35): Mit `SCHULOS_PUBLIC_ACCESS=oeffentliche-seiten`
// reicht Caddy Anfragen aus dem Internet nur für die öffentlichen Seiten durch und kennzeichnet sie mit `X-SchulOS-Extern: 1`.
// Diese Datei ist die zweite Verteidigungslinie in der App (`src/proxy.ts`): eine gekennzeichnete Anfrage bekommt nur die
// Pfade aus der Allowlist, ohne Sitzung (Cookie/Authorization werden verworfen).
//
// Den Header setzt ausschließlich Caddy – ein vom Browser mitgeschickter wird dort immer entfernt (compose.yaml). Die App
// wertet daher schon das bloße Vorhandensein als „von außen“ (egal welcher Wert): Fehlkonfiguration sperrt, statt zu öffnen.

/** Header, mit dem Caddy Anfragen aus dem Internet kennzeichnet (kleingeschrieben – so liefert ihn `Headers`) */
export const EXTERN_HEADER = "x-schulos-extern";

/** Werte von `SCHULOS_PUBLIC_ACCESS` (`.env` des Stacks, Installer `web.public_access`) – Vorgabe `keiner` */
export const PUBLIC_ACCESS_MODES = ["keiner", "oeffentliche-seiten", "alles"] as const;
export type PublicAccessMode = (typeof PUBLIC_ACCESS_MODES)[number];

/** genau diese Pfade (ohne abschließenden Schrägstrich) */
// A11Y-02: Erklärung zur Barrierefreiheit ist öffentlich (wie Impressum)
const EXACT = new Set(["/anmeldung", "/impressum", "/datenschutzhinweise", "/barrierefreiheit", "/api/schule/logo", "/icon.png", "/favicon.ico"]);
/** alles darunter (mindestens ein weiteres Zeichen) */
const PREFIXES = ["/anmeldung/", "/_next/static/"];

/**
 * Dieselbe Liste in Caddy-Schreibweise (`@oeffentlich path …` in compose.yaml). Ein Test vergleicht beide –
 * Caddys `path` vergleicht ohne Groß/Klein, die App genau; was nur Caddy durchlässt, sperrt hier die App.
 */
export const CADDY_PUBLIC_PATHS = [...EXACT, ...PREFIXES.map((p) => `${p}*`)];

/**
 * Verdächtige Pfade von außen grundsätzlich ablehnen statt zu normalisieren: kodierte Punkte/Schrägstriche/Backslashes/
 * Nullbytes/Prozent (`%2e`, `%2f`, `%5c`, `%00`, `%25`), rohe Backslashes, Steuerzeichen, doppelte Schrägstriche und
 * Punkt-Segmente (`/./`, `/../`, auch am Ende). Next löst `..` zwar vorher auf – geprüft wird trotzdem, damit die
 * Entscheidung nicht von der Normalisierung einer bestimmten Next-Version abhängt.
 */
const SUSPICIOUS = /%(?:2e|2f|5c|00|25)|\\|[\u0000-\u001f\u007f]|\/\/|\/\.{1,2}(?:\/|$)/i;

/** Darf eine Anfrage von außen diesen Pfad (ohne Query) erreichen? Groß/Klein zählt; ein abschließender `/` ist erlaubt. */
export function externalPathAllowed(pathname: string): boolean {
  if (!pathname.startsWith("/") || SUSPICIOUS.test(pathname)) return false;
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return EXACT.has(p) || PREFIXES.some((x) => p.startsWith(x) && p.length > x.length);
}

/** Kommt die Anfrage laut Caddy von außen? (Vorhandensein des Headers genügt, siehe oben) */
export function isExternalRequest(headers: Headers): boolean {
  return headers.has(EXTERN_HEADER);
}

// ---------------------------------------------------------------- P4-40b: Gerätezertifikate, Anmeldung von außen
//
// Caddy setzt `X-SchulOS-Extern` je nach Weg einer Anfrage aus dem Internet (compose.yaml, Snippet `extern-mit-geraet`):
//   `alles`  – Modus „alles“: ganz SchulOS, Anmeldung möglich, die Rollen-Regeln greifen (Fingerabdruck, falls vorhanden)
//   `geraet` – durchgelassen nur wegen eines von der Schul-CA verifizierten Gerätezertifikats (Fingerabdruck in
//              `X-SchulOS-Geraet`); ohne gültiges, freigegebenes Zertifikat bekommt hier niemand eine Sitzung
//   `1` bzw. **jeder andere Wert** – nur die Allowlist ohne Sitzung (P4-40). Unbekanntes landet also immer im engsten Fall.
// `X-SchulOS-Geraet` setzt ebenfalls nur Caddy und nur für Anfragen von außen mit Zertifikat; mitgeschickte werden in Caddy
// **und** hier verworfen (src/proxy.ts reicht nur den geprüften Wert weiter, und nur in den Zonen `alles`/`geraet`).

/** Fingerabdruck (SHA-256 über das DER-Zertifikat, Hex klein) des von Caddy verifizierten Client-Zertifikats */
export const DEVICE_CERT_HEADER = "x-schulos-geraet";

/**
 * Woher kommt die Anfrage? `intern` = Schulnetz (kein Kennzeichen) · `oeffentlich` = von außen, nur Allowlist ohne
 * Sitzung · `alles` = von außen im Modus „alles“ · `geraet` = von außen, durchgelassen wegen eines Gerätezertifikats.
 */
export type ExternalZone = "intern" | "oeffentlich" | "alles" | "geraet";

const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * SHA-256 über null Bytes – so füllt Caddy 2.11 `{http.request.tls.client.fingerprint}` **ohne** Client-Zertifikat (nicht leer!).
 * Nie ein Gerät; zweite Linie hinter dem Caddy-Matcher `@geraet` (P4-40b-Fix, dort war das die Ursache für fail-open).
 */
export const EMPTY_CERT_FINGERPRINT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Fingerabdruck aus `X-SchulOS-Geraet` – nur genau 64 Hex-Zeichen klein (so schreibt Caddy ihn), nie der Leer-Hash, sonst null */
export function deviceFingerprint(headers: Headers): string | null {
  const v = headers.get(DEVICE_CERT_HEADER);
  return v && FINGERPRINT.test(v) && v !== EMPTY_CERT_FINGERPRINT ? v : null;
}

/** Zone einer Anfrage aus den Kennzeichen von Caddy – im Zweifel die engere (geschlossen statt offen) */
export function externalZone(headers: Headers): ExternalZone {
  if (!headers.has(EXTERN_HEADER)) return "intern";
  const v = headers.get(EXTERN_HEADER);
  if (v === "alles") return "alles";
  // „geraet“ ohne brauchbaren Fingerabdruck schickt Caddy nie – nicht vertrauen, Allowlist wie ohne Zertifikat
  if (v === "geraet") return deviceFingerprint(headers) ? "geraet" : "oeffentlich";
  return "oeffentlich";
}

/**
 * Auth-API von außen (Zonen alles/geraet): nur Anmelden, Abmelden, Sitzung lesen – alles andere (Sitzungen auflisten oder
 * beenden, TOTP-Adresse …) bleibt im Schulnetz; die Formulare der App laufen ohnehin über Server Actions.
 */
export const EXTERNAL_AUTH_API: ReadonlySet<string> = new Set(["/api/auth/sign-in/username", "/api/auth/sign-out", "/api/auth/get-session"]);

/** Anmeldung und zweiter Faktor – von außen mit Gerätezertifikat nötig, damit Personal sich anmelden kann */
export function loginPath(pathname: string): boolean {
  return /^\/login(?:\/|$)/.test(pathname) || EXTERNAL_AUTH_API.has(pathname);
}

/**
 * Anfrage-Header für die App: `X-SchulOS-Geraet` nur in den Zonen `alles`/`geraet` und nur als geprüfter Fingerabdruck;
 * in der Zone `oeffentlich` zusätzlich ohne Cookie/Authorization. null = unverändert weiterreichen.
 */
export function forwardedHeaders(headers: Headers, zone: ExternalZone): Headers | null {
  if (zone === "intern" && !headers.has(DEVICE_CERT_HEADER)) return null;
  const fp = zone === "alles" || zone === "geraet" ? deviceFingerprint(headers) : null;
  const out = zone === "oeffentlich" ? withoutCredentials(headers) : new Headers(headers);
  out.delete(DEVICE_CERT_HEADER);
  if (fp) out.set(DEVICE_CERT_HEADER, fp);
  return out;
}

/** Anfrage-Header ohne alles, was eine Sitzung tragen könnte – von außen gibt es keine Anmeldung (P4-40b: Gerätezertifikate). */
export function withoutCredentials(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete("cookie");
  out.delete("authorization");
  return out;
}

export const EXTERNAL_BLOCKED_TEXT = "Diese Seite ist nur im Schulnetz erreichbar.";

/** Hinweis auf der Anmeldeseite von außen (P4-40b) – vorab, damit eine Ablehnung nichts über das Passwort verraten muss */
export const EXTERNAL_LOGIN_HINT =
  "Du bist außerhalb des Schulnetzes. Lehrkräfte und Personal melden sich von hier nur auf einem Gerät mit Gerätezertifikat der Schule an, Verwaltungs- und Admin-Konten in der Regel nur im Schulnetz.";
