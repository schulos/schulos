// Vorschau-Instanz (B-35, INSTALLATION.md §5a.3): zweites Compose-Projekt `schulos-vorschau` mit Demo-Daten und Band
// „VORSCHAU“, immer die nächste Version (Kanal beta bzw. die freizugebende), eigene Subdomain über den Haupt-Caddy
// (Site-Datei im Volume caddy_sites), nachts zurückgesetzt, abschaltbar.
import { compareVersions, visibleIn, type ReleaseManifest } from "@schulos/server/release";

export const VORSCHAU_COMPOSE = "compose.vorschau.yaml";
export const VORSCHAU_SITE = "/etc/caddy/sites/vorschau.caddy";
/** Name der Vorschau-App im Netz `edge` des Hauptsystems (Alias in compose.vorschau.yaml) */
export const VORSCHAU_HOST = "schulos-vorschau";

/**
 * Welche Version die Vorschau zeigt: das neueste Release im Kanal beta, das neuer ist als die laufende Version
 * (das ist auch die nächste freizugebende); gibt es keines, die laufende Version selbst (null → laufendes Image).
 */
export function previewTarget(current: string, releases: ReleaseManifest[], now = new Date()): ReleaseManifest | null {
  const newer = releases.filter((r) => visibleIn(r, "beta", now) && compareVersions(r.version, current) > 0).sort((a, b) => compareVersions(a.version, b.version));
  return newer.at(-1) ?? null;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Vorgabe: vorschau.<Domain des Hauptsystems> */
export function previewDomain(mainDomain: string | undefined, explicit?: string): string {
  const d = (explicit ?? `vorschau.${mainDomain ?? "localhost"}`).trim().toLowerCase();
  if (!DOMAIN.test(d)) throw new Error(`Ungültige Adresse für die Vorschau: „${d}“`);
  return d;
}

export const VORSCHAU_EXTERN_WARNING =
  "ACHTUNG: Die Vorschau ist jetzt auch aus dem Internet erreichbar – mit Demo-Konten und bekanntem Passwort (admin/schulos). Der Name steht in öffentlichen Zertifikatslogs. Nur kurz so lassen, danach: schulosctl vorschau an (ohne --extern) bzw. vorschau aus.";

/** Kennzeichen der Caddy-Site „auch von außen“ (erste Zeile, s. vorschauSite) */
export const VORSCHAU_EXTERN_MARKER = "AUCH VON AUSSEN (--extern)";

export function isExternSite(siteText: string): boolean {
  return siteText.includes(VORSCHAU_EXTERN_MARKER);
}

/**
 * G4E-O16: Schulprofil (Logo, Name der echten Schule) und Erreichbarkeit aus dem Internet schließen sich aus – sonst stünde die
 * echte Schulmarke öffentlich neben allgemein bekannten Demo-Logins (Phishing-Optik, Verwechslung).
 */
export const VORSCHAU_PROFIL_EXTERN =
  "Schulprofil und --extern schließen sich aus: mit dem Profil sähe die öffentlich erreichbare Vorschau wie die echte Schule aus – mit bekannten Demo-Passwörtern. Entweder erst „schulosctl vorschau profil --aus“ oder die Vorschau nur im Schulnetz („schulosctl vorschau an“ ohne --extern).";

/**
 * Caddy-Site für die Vorschau – TLS wie beim Hauptsystem ({$SCHULOS_TLS}: internal oder E-Mail für Let's Encrypt).
 * GATE-4c (Projektleitung 2026-10-10): per Vorgabe **nur aus dem Schulnetz** (`SCHULOS_INTERNAL_NETS` wie die Haupt-Site), von außen
 * 403 – unabhängig von `SCHULOS_PUBLIC_ACCESS`. Nur mit `extern` auch von außen, dann wie Modus „alles“ gekennzeichnet
 * (`X-SchulOS-Extern: alles` – die Regeln der App für Verwaltung/Admin/Personal von außen gelten). Mitgeschickte Kennzeichen
 * werden immer verworfen; die App bekommt nur die von Caddy ermittelte Client-Adresse.
 */
export function vorschauSite(domain: string, opts: { extern?: boolean } = {}): string {
  if (!DOMAIN.test(domain)) throw new Error(`Ungültige Adresse für die Vorschau: „${domain}“`);
  const proxy = [`reverse_proxy ${VORSCHAU_HOST}:3000 {`, "  flush_interval -1", "  header_up X-Forwarded-For {client_ip}", "}"];
  const indent = (lines: string[]) => lines.map((l) => `    ${l}`);
  return [
    `# geschrieben von schulosctl vorschau an – Vorschau-Instanz (Demo-Daten), ${opts.extern ? VORSCHAU_EXTERN_MARKER : "nur Schulnetz"}`,
    `${domain} {`,
    "  tls {$SCHULOS_TLS}",
    "  import kompression",
    "  header -Server",
    "  # nicht in Suchmaschinen",
    '  header X-Robots-Tag "noindex, nofollow"',
    "  # Kennzeichen setzt nur Caddy – mitgeschickte immer verwerfen",
    "  request_header -X-SchulOS-Extern",
    "  request_header -X-SchulOS-Geraet",
    "  @extern not client_ip {$SCHULOS_INTERNAL_NETS:private_ranges}",
    "  handle @extern {",
    ...(opts.extern ? ["    request_header X-SchulOS-Extern alles", ...indent(proxy)] : ['    respond "Die Vorschau ist nur im Schulnetz erreichbar." 403']),
    "  }",
    "  handle {",
    ...indent(proxy),
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * P4-77/Q-4E-28: Schulprofil im Konfigurationsordner der Vorschau – `node cli.mjs demo-reset` spielt es nach jedem
 * Zurücksetzen ein (`<SCHULOS_CONFIG_DIR>/schulprofil.json`, App-Teil auf Branch q5-4e-r3).
 */
export const VORSCHAU_SCHULPROFIL = "/srv/schulos/config/schulprofil.json";

/** Ausgabe von `node cli.mjs schulprofil-export` grob prüfen (Inhalt prüft der Import): ein JSON-Objekt mit Fassung */
export function checkSchulprofilExport(text: string): string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("Schulprofil-Export: keine gültige JSON-Ausgabe");
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || !("version" in v)) throw new Error("Schulprofil-Export: unerwartetes Format (ohne „version“)");
  return JSON.stringify(v, null, 2) + "\n";
}
