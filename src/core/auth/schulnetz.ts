// SEC-01: Kommt eine Anfrage aus dem Schulnetz? Grundlage für die 2FA-Pflicht der Schüler:innen (nur von außen) und für die
// Ersteinrichtung der 2FA (Q-5A-30: nur im Schulnetz oder mit Freigabe der Verwaltung). Rein, ohne DB – vollständig getestet.
//
// Zwei Quellen, die engere gewinnt:
//   1. Caddy kennzeichnet Anfragen von außen mit `X-SchulOS-Extern` (SCHULOS_INTERNAL_NETS, compose.yaml) → immer „außen“.
//   2. Die Client-IP aus `X-Forwarded-For` muss in den Schulnetz-Bereichen der Schule liegen (Verwaltung → System → Anmeldung).
//      Caddy glaubt X-Forwarded-For nur von eingetragenen Proxys (`trusted_proxies_strict`) und **ersetzt** den Header durch die
//      ermittelte Adresse; die App liest deshalb von rechts und überspringt nur Proxys aus `SCHULOS_TRUSTED_PROXIES`. Ein vom
//      Browser vorangestelltes `X-Forwarded-For: 10.0.0.5, …` zählt so nie.
// Ohne Adresse (kein Proxy davor – Entwicklung, E2E) gilt die Anfrage als Schulnetz: in Produktion steht immer Caddy davor.
import { isIP } from "node:net";
import { EXTERN_HEADER } from "@/core/external-access";

export interface Net {
  v: 4 | 6;
  base: bigint;
  bits: number;
}

/** Caddys `private_ranges` (Vorgabe von SCHULOS_INTERNAL_NETS) */
export const PRIVATE_RANGES = "192.168.0.0/16 172.16.0.0/12 10.0.0.0/8 127.0.0.1/8 fd00::/8 ::1";

function v4(ip: string): bigint {
  return ip.split(".").reduce((n, p) => (n << 8n) | BigInt(Number(p)), 0n);
}

function v6(ip: string): bigint | null {
  let s = ip;
  // eingebettete IPv4 am Ende (::ffff:1.2.3.4) in zwei Hex-Gruppen umwandeln
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4(tail[1]!);
    s = s.slice(0, -tail[1]!.length) + `${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head = "", rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const groups = rest !== undefined ? [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

/** Adresse als Zahl; IPv4-in-IPv6 (`::ffff:1.2.3.4`) gilt als IPv4. null bei ungültiger Eingabe. */
export function parseIp(raw: string): { v: 4 | 6; n: bigint } | null {
  const ip = raw
    .trim()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
  const kind = isIP(ip);
  if (kind === 4) return { v: 4, n: v4(ip) };
  if (kind !== 6) return null;
  const n = v6(ip.toLowerCase());
  if (n === null) return null;
  if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
  return { v: 6, n };
}

function parseNet(entry: string): Net | null {
  const [addr = "", prefix] = entry.split("/");
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = prefix === undefined ? max : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v: ip.v, base: ip.n & mask, bits };
}

/**
 * Liste von Bereichen (CIDR oder einzelne Adressen, getrennt durch Leerzeichen, Komma oder Zeilen; `private_ranges` wie in
 * Caddy). Ungültige Einträge stehen in `errors` und zählen nicht.
 */
export function parseNetList(text: string): { nets: Net[]; errors: string[] } {
  const nets: Net[] = [];
  const errors: string[] = [];
  for (const entry of text.split(/[\s,;]+/).filter(Boolean)) {
    if (entry === "private_ranges") {
      nets.push(...parseNetList(PRIVATE_RANGES).nets);
      continue;
    }
    const net = parseNet(entry);
    if (net) nets.push(net);
    else errors.push(entry);
  }
  return { nets, errors };
}

/** Liegt die Adresse in einem der Bereiche? */
export function ipInNets(ip: string, nets: readonly Net[]): boolean {
  const a = parseIp(ip);
  if (!a) return false;
  return nets.some((net) => {
    if (net.v !== a.v) return false;
    const max = net.v === 4 ? 32 : 128;
    const mask = net.bits === 0 ? 0n : ((1n << BigInt(net.bits)) - 1n) << BigInt(max - net.bits);
    return (a.n & mask) === net.base;
  });
}

/**
 * Client-Adresse aus `X-Forwarded-For`: von rechts gelesen, eingetragene Proxys übersprungen. null ohne Header bzw. ohne
 * gültige Adresse (dann gibt es keinen Proxy davor).
 */
export function forwardedClientIp(headers: Headers, trusted: readonly Net[] = []): string | null {
  const raw = headers.get("x-forwarded-for");
  if (!raw) return null;
  const hops = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!parseIp(hop)) return null; // Unsinn im Header: lieber „außen“ als irgendeine Adresse weiter links glauben
    if (i > 0 && ipInNets(hop, trusted)) continue;
    return hop;
  }
  return null;
}

export type NetworkZone = "schulnetz" | "aussen";

/** Schulnetz oder außen? Kennzeichen von Caddy schlägt alles; ungültiger Header → außen; ohne Adresse → Schulnetz. */
export function networkZone(headers: Headers, schoolNets: readonly Net[], trusted: readonly Net[] = []): NetworkZone {
  if (headers.has(EXTERN_HEADER)) return "aussen";
  const raw = headers.get("x-forwarded-for");
  if (!raw?.trim()) return "schulnetz";
  const ip = forwardedClientIp(headers, trusted);
  return ip && ipInNets(ip, schoolNets) ? "schulnetz" : "aussen";
}

/** Vertrauenswürdige Proxys vor der App (dieselbe Variable wie für Caddy; Vorgabe keine). */
export function trustedProxies(env: Record<string, string | undefined> = process.env): Net[] {
  return parseNetList(env.SCHULOS_TRUSTED_PROXIES ?? "").nets;
}

/** Vorgabe der Schulnetz-Bereiche, solange die Schule nichts eingetragen hat: SCHULOS_INTERNAL_NETS bzw. alle privaten Bereiche. */
export function defaultSchoolNets(env: Record<string, string | undefined> = process.env): string {
  return env.SCHULOS_INTERNAL_NETS?.trim() || "private_ranges";
}
