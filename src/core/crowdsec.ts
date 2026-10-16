// SEC-15 (optional, Vorgabe aus): CrowdSec erkennt Angriffe in Caddys Zugriffsprotokoll (Compose-Profil „crowdsec“) und
// entscheidet über Sperren; die App ist der „Bouncer“: der Proxy (src/proxy.ts) fragt bei jeder Anfrage einen Zwischenspeicher
// der aktiven Sperren ab, den sie alle 10 Sekunden über die lokale API von CrowdSec (Liste der aktiven Sperren) auffrischt. Kein Paket, keine
// Weitergabe an die Community-Liste (DISABLE_ONLINE_API, Datenschutz – docs/DATENSCHUTZ.md).
//   SCHULOS_CROWDSEC_URL=http://crowdsec:8080   SCHULOS_CROWDSEC_BOUNCER_KEY=<zufällig, auch in der .env für CrowdSec>
// Fällt CrowdSec aus, bleibt der letzte Stand (Sperren laufen ab) – die Seite bleibt erreichbar (fail open, Q-4E-58).

export interface CrowdsecConfig {
  url: string;
  key: string;
}

export function crowdsecConfig(
  env: Record<string, string | undefined> = process.env,
): CrowdsecConfig | null {
  const url = env.SCHULOS_CROWDSEC_URL?.trim().replace(/\/+$/, "");
  const key = env.SCHULOS_CROWDSEC_BOUNCER_KEY?.trim();
  if (!url || !key || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(url))
    return null;
  return { url, key };
}

export const CROWDSEC_BLOCKED_TEXT =
  "Zugriff vorübergehend gesperrt (Sicherheitsfilter). Bitte später erneut versuchen.";
export const CROWDSEC_REFRESH_MS = 10_000;

interface Decision {
  value?: unknown;
  scope?: unknown;
  type?: unknown;
  duration?: unknown;
}

export interface BanCache {
  ips: Map<string, number>;
  ranges: { net: number; bits: number; value: string; until: number }[];
  lastPull: number;
  started: boolean;
  error: string | null;
  pulling: boolean;
}

export function emptyCache(): BanCache {
  return {
    ips: new Map(),
    ranges: [],
    lastPull: 0,
    started: false,
    error: null,
    pulling: false,
  };
}

/** Go-Dauer („3h59m58.1s“, „5m“, „-1s“) in Millisekunden; ungültig → 0 */
export function parseGoDuration(d: unknown): number {
  if (typeof d !== "string") return 0;
  let ms = 0;
  let matched = false;
  for (const m of d.matchAll(/(-?\d+(?:\.\d+)?)(h|ms|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    ms +=
      m[2] === "h"
        ? n * 3600_000
        : m[2] === "m"
          ? n * 60_000
          : m[2] === "s"
            ? n * 1000
            : n;
  }
  return matched && ms > 0 ? ms : 0;
}

function ipv4(s: string): number | null {
  const p = s.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255))
    return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

function rangeOf(value: string): { net: number; bits: number } | null {
  const [a, b] = value.split("/");
  const ip = a ? ipv4(a) : null;
  const bits = Number(b);
  if (ip === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
    return null;
  const size = 2 ** (32 - bits);
  return { net: Math.floor(ip / size) * size, bits };
}

/** Antwort von /v1/decisions/stream übernehmen (nur Sperren vom Typ „ban“; IPv6-Bereiche werden nicht unterstützt) */
export function applyStream(
  cache: BanCache,
  body: { new?: Decision[] | null; deleted?: Decision[] | null },
  now = Date.now(),
): void {
  for (const d of body.deleted ?? []) {
    if (typeof d.value !== "string") continue;
    cache.ips.delete(d.value.toLowerCase());
    cache.ranges = cache.ranges.filter((r) => r.value !== d.value);
  }
  for (const d of body.new ?? []) {
    if (
      typeof d.value !== "string" ||
      (d.type !== undefined && d.type !== "ban")
    )
      continue;
    const until = now + parseGoDuration(d.duration);
    if (until <= now) continue;
    const scope = typeof d.scope === "string" ? d.scope.toLowerCase() : "ip";
    if (scope === "range") {
      const r = rangeOf(d.value);
      if (r)
        cache.ranges = [
          ...cache.ranges.filter((x) => x.value !== d.value),
          { ...r, value: d.value, until },
        ];
    } else if (scope === "ip") cache.ips.set(d.value.toLowerCase(), until);
  }
}

export function isBanned(
  cache: BanCache,
  ip: string,
  now = Date.now(),
): boolean {
  const key = ip.trim().toLowerCase();
  const until = cache.ips.get(key);
  if (until !== undefined) {
    if (until > now) return true;
    cache.ips.delete(key);
  }
  const n = ipv4(key);
  if (n === null) return false;
  return cache.ranges.some(
    (r) =>
      r.until > now &&
      Math.floor(n / 2 ** (32 - r.bits)) * 2 ** (32 - r.bits) === r.net,
  );
}

export function activeBans(cache: BanCache, now = Date.now()): number {
  return (
    [...cache.ips.values()].filter((u) => u > now).length +
    cache.ranges.filter((r) => r.until > now).length
  );
}

/**
 * Ein Abgleich mit der lokalen API: die Liste ALLER aktiven Sperren (`GET /v1/decisions`) ersetzt den Zwischenspeicher.
 * GATE-4e (CI-Befund): früher der Stream (`/v1/decisions/stream`, nur Änderungen seit dem letzten Abruf dieses Bouncers) – holen
 * zwei Stellen mit demselben Schlüssel ab (Serverstart-Abgleich und Proxy, ggf. in getrennten Modul-Instanzen), bekommt nur die
 * erste eine neue Sperre zu sehen und die andere nie. Die volle Liste ist zustandslos; ohne Community-Liste ist sie klein.
 */
export async function pull(
  cfg: CrowdsecConfig,
  cache: BanCache,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<void> {
  if (cache.pulling) return;
  cache.pulling = true;
  try {
    const res = await fetchImpl(`${cfg.url}/v1/decisions`, {
      headers: { "X-Api-Key": cfg.key },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`CrowdSec antwortet mit ${res.status}`);
    // keine Sperren: LAPI antwortet mit `null`
    const list = (await res.json()) as Decision[] | null;
    if (list !== null && !Array.isArray(list)) throw new Error("CrowdSec: unerwartete Antwort");
    cache.ips = new Map();
    cache.ranges = [];
    applyStream(cache, { new: list ?? [] }, now);
    cache.started = true;
    cache.error = null;
  } catch (err) {
    cache.error = err instanceof Error ? err.message : String(err);
  } finally {
    cache.lastPull = now;
    cache.pulling = false;
  }
}

const g = globalThis as unknown as { __schulosCrowdsec?: BanCache; __schulosCrowdsecTimer?: NodeJS.Timeout };

export function banCache(): BanCache {
  return (g.__schulosCrowdsec ??= emptyCache());
}

/** Endungen, die der erste Matcher in src/proxy.ts ausnimmt (statische Dateien) */
export const STATIC_EXTENSION = /\.(?:png|svg|ico|webp|jpg|css|js|woff2?)$/;

/**
 * G4E-O13: Anfragen, für die der Proxy früher gar nicht lief (im Schulnetz: Prefetch-Header, Pfade mit Dateiendung) – seit
 * G4E-O13 läuft er für sie nur noch wegen der CrowdSec-Sperre (sonst ließe sie sich mit einem Prefetch-Header oder `…/x.png`
 * umgehen) und lässt sie danach unverändert durch. Von außen gekennzeichnete Anfragen gehören nicht dazu (volle Prüfung).
 */
export function crowdsecOnlyRequest(pathname: string, headers: Headers): boolean {
  if (headers.has("x-schulos-extern") || headers.has("x-schulos-geraet")) return false;
  return headers.has("next-router-prefetch") || headers.get("purpose") === "prefetch" || STATIC_EXTENSION.test(pathname);
}

/**
 * Für den Proxy (synchron): gesperrt? Ist der Stand älter als 10 s, wird im Hintergrund nachgeladen – die Anfrage wartet
 * nicht darauf. Den ersten Abgleich holt der Serverstart (startCrowdsecSync), sonst kämen gesperrte Adressen direkt nach einem
 * Neustart der App noch durch (CI-Befund GATE-4e). Ohne Einstellung immer false.
 */
export function crowdsecBlocked(
  ip: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): boolean {
  const cfg = crowdsecConfig(env);
  if (!cfg || !ip) return false;
  const cache = banCache();
  if (now - cache.lastPull >= CROWDSEC_REFRESH_MS) void pull(cfg, cache, fetch, now);
  return isBanned(cache, ip, now);
}

/**
 * Serverstart (src/core/startup.ts): ersten Abgleich abwarten (höchstens 3 s; scheitert er, fail open – Q-4E-58) und danach
 * alle 10 s im Hintergrund abgleichen, unabhängig von Anfragen. Ohne Einstellung nichts. Liefert, ob er lief.
 */
export async function startCrowdsecSync(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const cfg = crowdsecConfig(env);
  if (!cfg || g.__schulosCrowdsecTimer) return false;
  const cache = banCache();
  await pull(cfg, cache, fetchImpl, Date.now());
  g.__schulosCrowdsecTimer = setInterval(() => void pull(cfg, cache, fetchImpl, Date.now()), CROWDSEC_REFRESH_MS);
  g.__schulosCrowdsecTimer.unref?.();
  return true;
}

/** nur für Tests */
export function stopCrowdsecSync(): void {
  if (g.__schulosCrowdsecTimer) clearInterval(g.__schulosCrowdsecTimer);
  delete g.__schulosCrowdsecTimer;
}

/** Für Verwaltung → System: aktive Sperren direkt von der lokalen API (unabhängig vom Zwischenspeicher des Proxys) */
export async function crowdsecStatus(
  cfg: CrowdsecConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; active: number } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`${cfg.url}/v1/decisions`, {
      headers: { "X-Api-Key": cfg.key },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok)
      return { ok: false, error: `CrowdSec antwortet mit ${res.status}` };
    const list = (await res.json()) as Decision[] | null;
    return {
      ok: true,
      active: (list ?? []).filter(
        (d) => d.type === undefined || d.type === "ban",
      ).length,
    };
  } catch (err) {
    return {
      ok: false,
      error: `CrowdSec nicht erreichbar (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
