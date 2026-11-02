// CA-02…CA-05 (docs/ZERTIFIKATE.md): Wurzelzertifikat („Root“) der eigenen CA – nur das öffentliche Zertifikat, nie ein Schlüssel.
// schulosctl liest es aus dem Caddy-Container und legt es als `root-ca.crt` in den Konfigurationsordner der App (bzw. des
// Backupservers liegt es unter /ca/root.crt); App und Backupserver liefern es zum Download aus. Gemeinsam: Erkennen, Prüfen,
// Fingerabdruck, Umwandeln in DER (`.cer`) und das Apple-Profil (`.mobileconfig`).
import { createHash, X509Certificate } from "node:crypto";
import type { RootCaInfo } from "./system";

export type { RootCaInfo } from "./system";

/** Erstes PEM-Zertifikat aus dem Text, normalisiert (sonst null). Ein privater Schlüssel im Text wird nie übernommen. */
export function firstCertificatePem(text: string): string | null {
  const m = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/.exec(text);
  return m ? `${m[0].replace(/\r\n/g, "\n")}\n` : null;
}

/** Fingerabdruck (SHA-256, „AB:CD:…“), Ablauf und Name der Root; null, wenn es kein CA-Zertifikat ist. */
export function rootCaInfo(text: string): RootCaInfo | null {
  const pem = firstCertificatePem(text);
  if (!pem) return null;
  try {
    const c = new X509Certificate(pem);
    if (!c.ca) return null;
    return { fingerprint: c.fingerprint256, notAfter: new Date(c.validTo).toISOString() };
  } catch {
    return null;
  }
}

/** Root als PEM + Angaben, wenn der Text ein CA-Zertifikat enthält (sonst null). */
export function parseRootCa(text: string): { pem: string; info: RootCaInfo } | null {
  const pem = firstCertificatePem(text);
  const info = pem ? rootCaInfo(pem) : null;
  return pem && info ? { pem, info } : null;
}

/** DER-Bytes (für `.cer`, Windows-Doppelklick) */
export function pemToDer(pem: string): Buffer {
  return new X509Certificate(pem).raw;
}

/** Fingerabdruck in zwei Hälften (je 16 Bytes) – für schmale Ausgaben (Konsole, Handy) */
export function fingerprintLines(fingerprint: string): [string, string] {
  const parts = fingerprint.split(":");
  return [parts.slice(0, 16).join(":"), parts.slice(16).join(":")];
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** stabile UUID (v4-Form) aus einem Text – gleiche Root ergibt dasselbe Profil (ersetzt beim erneuten Import statt doppelt) */
function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

/**
 * CA-04: Apple-Konfigurationsprofil (`.mobileconfig`, unsigniert) mit genau der Root als „com.apple.security.root“. Für die
 * Geräteverwaltung oder zum Antippen auf iPad/Mac; danach in den Einstellungen das volle Vertrauen einschalten. Kennung aus dem
 * Fingerabdruck: eine neue Root ergibt ein eigenes Profil (das alte von Hand entfernen).
 */
export function mobileconfig(pem: string, opts: { name: string; identifier?: string }): string {
  const c = new X509Certificate(pem);
  const id = (opts.identifier ?? "schulos.root-ca").replace(/[^A-Za-z0-9.-]/g, "-");
  const fp = c.fingerprint256.replace(/:/g, "").toLowerCase();
  const b64 = c.raw.toString("base64").replace(/.{1,64}/g, "$&\n").trimEnd();
  const name = xml(opts.name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>root-ca.cer</string>
      <key>PayloadContent</key>
      <data>
${b64}
      </data>
      <key>PayloadDescription</key>
      <string>Wurzelzertifikat der eigenen Zertifizierungsstelle</string>
      <key>PayloadDisplayName</key>
      <string>${name}</string>
      <key>PayloadIdentifier</key>
      <string>${id}.${fp.slice(0, 16)}.cert</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${stableUuid(`${fp}:cert`)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Installiert das Wurzelzertifikat (SHA-256 ${xml(c.fingerprint256)}). Danach unter Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen das volle Vertrauen einschalten.</string>
  <key>PayloadDisplayName</key>
  <string>${name}</string>
  <key>PayloadIdentifier</key>
  <string>${id}.${fp.slice(0, 16)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${stableUuid(`${fp}:profil`)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

export const ROOT_CA_FORMATS = ["crt", "cer", "mobileconfig"] as const;
export type RootCaFormat = (typeof ROOT_CA_FORMATS)[number];

export function isRootCaFormat(v: string): v is RootCaFormat {
  return (ROOT_CA_FORMATS as readonly string[]).includes(v);
}

/**
 * Download-Antwort für App und Backupserver: `.crt` (PEM), `.cer` (DER, Doppelklick unter Windows) oder Apple-`.mobileconfig`.
 * Nur das Zertifikat; `filename` ohne Endung.
 */
export function rootCaDownload(pem: string, format: RootCaFormat, opts: { name: string; filename: string; identifier?: string }): Response {
  const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  const file = (ext: string) => `attachment; filename="${opts.filename.replace(/[^A-Za-z0-9._-]/g, "-")}.${ext}"`;
  if (format === "mobileconfig")
    return new Response(mobileconfig(pem, { name: opts.name, identifier: opts.identifier }), {
      headers: { ...headers, "Content-Type": "application/x-apple-aspen-config", "Content-Disposition": file("mobileconfig") },
    });
  if (format === "cer") return new Response(new Uint8Array(pemToDer(pem)), { headers: { ...headers, "Content-Type": "application/pkix-cert", "Content-Disposition": file("cer") } });
  return new Response(pem, { headers: { ...headers, "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": file("crt") } });
}
