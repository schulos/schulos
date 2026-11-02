// CA-06: öffentliche Domain, Server nur im Schulnetz – Let's Encrypt per DNS-Prüfung (ACME DNS-01, docs/ZERTIFIKATE.md Teil B).
// Anbieter der Stufe 1 (Projektleitung 2026-11-01, ca-3) mit den Zugangsangaben, die ihr Caddy-Modul braucht. Jede Angabe
// landet als eigene Variable in der .env des Stacks (Rechte 600) und kommt nur als Laufzeit-Platzhalter in die
// Caddy-Konfiguration (Snippets `tls-dns-<anbieter>` in compose.yaml – compose-dns.test.ts vergleicht beide Seiten).

/** Zugangsangaben; je Feld eine Frage `web.dns_<feld>` und eine Variable der .env */
export type DnsField = "user" | "token" | "shared_secret" | "secret" | "server" | "key_alg";

/** Variable der .env je Feld (Shared Secret von INWX nutzt dieselbe wie das Token – nie beide bei einem Anbieter) */
export const DNS_ENV: Record<DnsField, string> = {
  user: "SCHULOS_DNS_USER",
  token: "SCHULOS_DNS_TOKEN",
  shared_secret: "SCHULOS_DNS_TOKEN",
  secret: "SCHULOS_DNS_SECRET",
  server: "SCHULOS_DNS_SERVER",
  key_alg: "SCHULOS_DNS_KEY_ALG",
};

export interface DnsProvider {
  value: string;
  label: string;
  /** Pflichtangaben, in dieser Reihenfolge gefragt */
  fields: DnsField[];
  /** freiwillige Angaben */
  optional?: DnsField[];
  /** kurz: welcher Zugang mit welchen (minimalen) Rechten – steht in der Hilfe und in INSTALLATION.md */
  access: string;
}

export const DNS_PROVIDERS: readonly DnsProvider[] = [
  { value: "cloudflare", label: "Cloudflare", fields: ["token"], access: "API-Token mit „Zone → Zone → Lesen“ und „Zone → DNS → Bearbeiten“, nur für diese Zone" },
  { value: "hetzner", label: "Hetzner (Console)", fields: ["token"], access: "API-Token (Lesen & Schreiben) eines eigenen Projekts, das nur diese Zone enthält" },
  { value: "ionos", label: "IONOS", fields: ["token"], access: "API-Schlüssel „Präfix.Geheimnis“ (gilt für alle Zonen des Kontos – eigenes Konto nur für diese Domain empfohlen)" },
  { value: "netcup", label: "netcup", fields: ["user", "token", "secret"], access: "Kundennummer, API-Key und API-Passwort aus dem Kundenbereich (Prüfung dauert bei netcup bis zu 20 Minuten)" },
  { value: "inwx", label: "INWX", fields: ["user", "secret"], optional: ["shared_secret"], access: "eigenes API-Unterkonto mit Rechten nur für diese Domain; Shared Secret nur bei Zwei-Faktor-Anmeldung" },
  { value: "desec", label: "deSEC", fields: ["token"], access: "Token, auf diese Domain beschränkt" },
  { value: "route53", label: "AWS Route 53", fields: ["user", "secret"], access: "Zugangsschlüssel eines eigenen IAM-Benutzers mit Rechten nur auf die Hosted Zone" },
  { value: "rfc2136", label: "eigener DNS-Server (RFC 2136)", fields: ["server", "user", "key_alg", "secret"], access: "TSIG-Schlüssel, der nur _acme-challenge.<domain> per dynamischem Update ändern darf" },
];

export const DNS_PROVIDER_BY_VALUE = new Map(DNS_PROVIDERS.map((p) => [p.value, p]));

/** Felder (Pflicht und freiwillig), die ein Anbieter nutzt */
export function dnsFields(provider: string | undefined): DnsField[] {
  const p = provider ? DNS_PROVIDER_BY_VALUE.get(provider) : undefined;
  return p ? [...p.fields, ...(p.optional ?? [])] : [];
}

export const TSIG_ALGORITHMS = ["hmac-sha256", "hmac-sha384", "hmac-sha512"] as const;

/**
 * Format, das das Cloudflare-Modul beim Start verlangt (caddy-dns/cloudflare v0.2.4). Ein abgelehnter Token stünde sonst im Klartext
 * in dessen Fehlermeldung und damit im Caddy-Protokoll – darum prüft schon der Installer.
 */
export function isCloudflareToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{35,50}$/.test(s) || /^cf(ut|at)_[A-Za-z0-9_-]{32,256}$/.test(s);
}

/** Öffentliche DNS-Server für die Prüfung (Vorgabe) – im Schulnetz löst der Schul-DNS den Namen per Split-DNS anders auf */
export const DNS_RESOLVERS_DEFAULT = ["9.9.9.9", "1.1.1.1"];
