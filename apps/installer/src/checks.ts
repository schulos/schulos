// Prüfungen für die Installer-Eingaben (INSTALLATION.md §3) – rein, ohne Netz und Dateisystem.

/** Ein Hostname-Teil nach RFC 1123: 1–63 Zeichen, Buchstaben/Ziffern/Bindestrich, nicht am Rand. */
export function isHostLabel(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(s);
}

/** Domain bzw. Hostname (auch einteilig), keine IP-Adresse. */
export function isDomain(s: string): boolean {
  if (s.length > 253 || parseIPv4(s) !== null) return false;
  const labels = s.split(".");
  return labels.every(isHostLabel) && !/^\d+$/.test(labels[labels.length - 1]!);
}

/** Endungen, die nie öffentlich auflösbar sind – Let's Encrypt kann dafür kein Zertifikat ausstellen. */
const PRIVATE_TLDS = ["local", "lan", "internal", "intern", "home", "localhost", "test", "example", "invalid", "corp", "localdomain"];

/** Öffentliche Domain (für Let's Encrypt): mehrteilig, keine private Endung. */
export function isPublicDomain(s: string): boolean {
  if (!isDomain(s) || !s.includes(".")) return false;
  const lower = s.toLowerCase();
  return !PRIVATE_TLDS.includes(lower.split(".").pop()!) && !lower.endsWith(".home.arpa");
}

export function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

export interface Cidr {
  ip: number;
  prefix: number;
}

/** „192.168.10.5/24“ – Adresse mit Präfix 8–30, weder Netz- noch Broadcast-Adresse. */
export function parseCidr(s: string): { ok: true; cidr: Cidr } | { ok: false; error: string } {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(s.trim());
  const ip = m ? parseIPv4(m[1]!) : null;
  if (!m || ip === null) return { ok: false, error: "IPv4-Adresse mit Präfix, z. B. 192.168.10.5/24" };
  const prefix = Number(m[2]);
  if (prefix < 8 || prefix > 30) return { ok: false, error: "Präfix 8 bis 30 (z. B. /24 = 255.255.255.0)" };
  const host = ip % 2 ** (32 - prefix);
  if (host === 0 || host === 2 ** (32 - prefix) - 1) return { ok: false, error: "Das ist die Netz- bzw. Broadcast-Adresse, keine Geräteadresse" };
  return { ok: true, cidr: { ip, prefix } };
}

export function inSubnet(ip: number, net: Cidr): boolean {
  const size = 2 ** (32 - net.prefix);
  return Math.floor(ip / size) === Math.floor(net.ip / size);
}

export function isEmail(s: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);
}

/** Absender wie „SchulOS <schulos@schule.de>“ oder nur die Adresse (gleiche Regel wie @schulos/server/mail). */
export function isSender(s: string): boolean {
  return isEmail(s.replace(/^.*<(.+)>$/, "$1"));
}

/** https-Adresse ohne Pfad/Query, optional mit Port – null oder Fehlertext. */
export function checkHttpsUrl(s: string): string | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "Adresse wie https://backup.schule.de";
  }
  if (u.protocol !== "https:") return "Nur https://";
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username) return "Nur die Adresse, ohne Pfad und Zugangsdaten";
  return null;
}

/** Proxy-Adresse http(s)://host:port, optional mit Zugangsdaten. */
export function checkProxyUrl(s: string): string | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "Adresse wie http://proxy.schule.de:3128";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "http:// oder https://";
  if (!u.port) return "Mit Port, z. B. :3128";
  return null;
}

const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( .*)?$/;

export function isSshKey(s: string): boolean {
  return SSH_KEY.test(s.trim());
}

/** Wartungsfenster „02:00-04:00“: 1–6 Stunden, darf über Mitternacht gehen. Minuten seit 0 Uhr. */
export function parseWindow(s: string): { ok: true; start: number; end: number; minutes: number } | { ok: false; error: string } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) return { ok: false, error: "Von–bis im Format HH:MM-HH:MM, z. B. 02:00-04:00" };
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const minutes = (end - start + 24 * 60) % (24 * 60);
  if (minutes < 60 || minutes > 360) return { ok: false, error: "Das Fenster muss 1 bis 6 Stunden lang sein" };
  return { ok: true, start, end, minutes };
}

export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Gerätepfad einer Platte, z. B. /dev/sda, /dev/nvme0n1, /dev/disk/by-id/… */
export function isDiskPath(s: string): boolean {
  return /^\/dev\/[A-Za-z0-9/_.:-]+$/.test(s) && !s.includes("..");
}

/**
 * Lässt sich der Wert in eine env-Datei schreiben, die Compose (env_file) und parseEnvFile gleich lesen? Einfache
 * Anführungszeichen sind wörtlich; enthält der Wert selbst einen Apostroph, gehen nur doppelte – ohne $ " \ (Compose ersetzt dort).
 */
export function envSafe(s: string): boolean {
  if (/[\r\n]/.test(s)) return false;
  return !s.includes("'") || !/[$"\\]/.test(s);
}

/**
 * IP-Adresse oder Netz für Caddys `trusted_proxies` (P4-40): IPv4 (`10.0.0.5`, `10.0.0.0/29`) oder IPv6 (`fd00::5`, `fd00::/64`).
 * Anders als parseCidr ist hier auch die Netzadresse erlaubt – gemeint ist ein Bereich, keine Geräteadresse.
 */
export function isIpOrCidr(s: string): boolean {
  const [ip, prefix, ...rest] = s.trim().split("/");
  if (rest.length || !ip) return false;
  if (parseIPv4(ip) !== null) return prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
  const v6 = /^[0-9a-f:]+$/i.test(ip) && ip.includes(":") && (ip.match(/::/g)?.length ?? 0) <= 1 && ip.split(":").every((g) => g.length <= 4);
  return v6 && (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128));
}
