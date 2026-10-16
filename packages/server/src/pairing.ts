// Kopplung Hauptsystem ↔ Backupserver (INSTALLATION.md §4.3). Rein, gemeinsam für beide Seiten.
//
// Der Kopplungscode (12 Zeichen, 60 Bit, 24 h gültig, einmalig) geht nie übers Netz. Aus ihm entstehen
//  - ein Suchschlüssel (`lookup`), mit dem der Backupserver den offenen Code findet, und
//  - ein AES-256-GCM-Schlüssel, mit dem beide Seiten ihre Nachrichten verschlüsseln und authentisieren.
// Ablauf: „hello“ (TLS noch ungeprüft) liefert das CA-Zertifikat des Backupservers verschlüsselt – wer den Code nicht kennt,
// kann es weder lesen noch fälschen. Danach läuft „claim“ nur noch über TLS mit dieser CA (Pinning) bzw. dem System-Truststore.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, X509Certificate } from "node:crypto";

/** Crockford-Base32 ohne I, L, O, U – gut abzutippen. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 12;
export const PAIRING_VALID_HOURS = 24;

function randomBase32(chars: number): string {
  const bytes = randomBytes(chars);
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

function group(s: string, size: number): string {
  return s.match(new RegExp(`.{1,${size}}`, "g"))!.join("-");
}

/** Neuer Kopplungscode, z. B. „K7Q2-9MXA-4RT1“. */
export function generatePairingCode(): string {
  return group(randomBase32(PAIRING_CODE_LENGTH), 4);
}

/** Eingabe normalisieren (Leerzeichen/Bindestriche, Kleinbuchstaben, O→0, I/L→1) – null, wenn es kein Code sein kann. */
export function normalizePairingCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== PAIRING_CODE_LENGTH || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return s;
}

/** Suchschlüssel (hex) – der Backupserver speichert nur ihn, nie den Code. */
export function pairingLookup(code: string): string {
  const n = normalizePairingCode(code);
  if (!n) throw new Error("Ungültiger Kopplungscode");
  return createHash("sha256").update(`schulos-pairing-lookup:${n}`).digest("hex");
}

/** AES-Schlüssel aus dem Code (HKDF-SHA256). */
export function pairingKey(code: string): Buffer {
  const n = normalizePairingCode(code);
  if (!n) throw new Error("Ungültiger Kopplungscode");
  return Buffer.from(hkdfSync("sha256", n, "schulos-pairing-v1", "key", 32));
}

/** Schlüssel für Geheimnisse in der eigenen Datenbank, abgeleitet aus dem App-Geheimnis (BETTER_AUTH_SECRET). */
export function atRestKey(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, "schulos-at-rest-v1", purpose, 32));
}

/** Verschlüsselt ein JSON-Objekt (AES-256-GCM); `aad` bindet es an seinen Zweck, z. B. "claim". Format „v1.iv.daten.tag“. */
export function seal(key: Buffer, value: unknown, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv, data, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Gegenstück zu seal(); wirft bei falschem Schlüssel, falschem Zweck oder veränderten Daten. */
export function open<T>(key: Buffer, sealed: string, aad: string): T {
  const [v, iv, data, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !data || !tag) throw new Error("Unbekanntes Format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

/** Zufälliges Geheimnis (Zugangsdaten, Tokens, Repo-Passwort). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Wiederherstellungsschlüssel zum Ausdrucken: 30 Zeichen Base32 in Fünfergruppen (150 Bit). */
export function generateRecoveryKey(): string {
  return group(randomBase32(30), 5);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** SHA-256-Fingerabdruck eines PEM-Zertifikats, „AB:CD:…“ – zum Anzeigen und Vergleichen. */
export function certFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

// ---------------------------------------------------------------- Nachrichten

/** Antwort auf „hello“ (verschlüsselt mit aad `hello:<lookup>`). */
export interface PairingHello {
  /** CA des Backupservers (eigene Caddy-CA); null = öffentliches Zertifikat, dann gilt der System-Truststore */
  caPem: string | null;
  serverName: string;
}

/** Anfrage „claim“ (aad `claim:<lookup>`) */
export interface PairingClaim {
  nonce: string;
  instanceName: string;
  /** Adresse des Hauptsystems – nur zur Anzeige auf dem Backupserver */
  mainUrl: string;
  /** Kopie des Repository-Passworts: der Backupserver braucht es für Prune, Prüfung und Test-Restore */
  repoPassword: string;
}

/** Antwort auf „claim“ (aad `claim-ok:<lookup>`) */
export interface PairingResult {
  nonce: string;
  instanceId: string;
  /** restic-Repository über den rest-server (append-only), z. B. https://backup.schule.de/restic/i-ab12cd34/ */
  repoUrl: string;
  restUser: string;
  restPassword: string;
  /** Zugang des Backup-Agenten zur API des Backupservers (Zeitplan holen, Ergebnisse melden) */
  agentToken: string;
  /**
   * Nur bei Ersatz-Kopplung (neue Hardware): Passwort des bestehenden Repositorys – das Hauptsystem übernimmt es statt seines eigenen,
   * der Wiederherstellungsschlüssel steckt schon im Repository. Auch bei einem wiederholten „claim“ (Antwort ging verloren): dann
   * zusammen mit `freshRepository`, denn das Repository ist neu und der Wiederherstellungsschlüssel noch nicht eingetragen.
   */
  repoPassword?: string;
  /** Wiederholung einer Neu-Kopplung: `repoPassword` stammt aus dem ersten Versuch, das Repository ist trotzdem neu */
  freshRepository?: boolean;
}

export const aad = {
  hello: (lookup: string) => `hello:${lookup}`,
  claim: (lookup: string) => `claim:${lookup}`,
  claimOk: (lookup: string) => `claim-ok:${lookup}`,
};
