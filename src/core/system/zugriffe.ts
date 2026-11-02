// BM-05: Auswerter für das IP-freie Betriebsprotokoll des Reverse-Proxys (docs/BETRIEBSMONITORING.md, Entscheidung bm-5).
// Caddy schreibt es immer (Snippet „betriebslog“ im Caddyfile, compose.yaml): JSON je Anfrage, die Anfrage selbst (IP, Port,
// Header, Pfad) entfernt Caddy schon vor dem Schreiben – übrig bleiben Zeit, Status, Dauer und Größe. Zeitbasiert gedreht,
// nichts ist älter als 48 h. Die App liest das Volume nur (`caddy_betrieb:ro`) und rechnet daraus Zähler; gespeichert wird nichts.
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import type { HealthProblem, TrafficStats, TrafficWindow } from "@schulos/server/system";

export const TRAFFIC_LOG_DIR = "/var/log/caddy-betrieb";
/** je Datei höchstens so viel vom Ende lesen – die Seite bleibt schnell, auch wenn der Proxy viel schreibt */
export const TRAFFIC_READ_LIMIT = 16 * 1024 * 1024;
/** Befund „zugriffe:5xx“: Anteil Serverfehler der letzten Stunde ab … Prozent, sobald genug Anfragen da sind */
export const TRAFFIC_5XX_WARN_PERCENT = 5;
export const TRAFFIC_5XX_MIN_REQUESTS = 20;

const HOUR = 3_600_000;
const MAX_AGE = 48 * HOUR;

export interface AccessEntry {
  /** Zeitpunkt in ms */
  at: number;
  status: number;
  /** Dauer in ms */
  durationMs: number;
}

/** Eine Zeile aus Caddys JSON-Log; alles, was nicht wie ein Zugriff aussieht, ergibt null. */
export function parseAccessLine(line: string): AccessEntry | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const { ts, status, duration } = o as { ts?: unknown; status?: unknown; duration?: unknown };
  if (typeof ts !== "number" || typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return null;
  const durationMs = typeof duration === "number" && duration >= 0 ? duration * 1000 : 0;
  return { at: Math.round(ts * 1000), status, durationMs };
}

/** Perzentil nach der Rangmethode (aufsteigend sortierte Werte), eine Nachkommastelle */
function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i]! * 10) / 10;
}

export function summarizeWindow(entries: readonly AccessEntry[]): TrafficWindow {
  const byClass = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  for (const e of entries) {
    const c = Math.floor(e.status / 100);
    if (c === 2) byClass["2xx"]++;
    else if (c === 3) byClass["3xx"]++;
    else if (c === 4) byClass["4xx"]++;
    else if (c === 5) byClass["5xx"]++;
  }
  const n = entries.length;
  if (n === 0) return { requests: 0, byClass, errorRate: null, latencyMs: null };
  const d = entries.map((e) => e.durationMs).sort((a, b) => a - b);
  return {
    requests: n,
    byClass,
    errorRate: Math.round((byClass["5xx"] / n) * 1000) / 10,
    latencyMs: { p50: percentile(d, 50), p95: percentile(d, 95), p99: percentile(d, 99) },
  };
}

export function summarizeTraffic(lines: Iterable<string>, now: Date): TrafficStats {
  const t = now.getTime();
  const day: AccessEntry[] = [];
  let oldest: number | null = null;
  for (const line of lines) {
    const e = parseAccessLine(line);
    // Einträge aus der Zukunft (Uhr verstellt) und älter als 48 h (sollte es nicht geben) zählen nicht
    if (!e || e.at > t + 60_000 || e.at < t - MAX_AGE) continue;
    if (oldest === null || e.at < oldest) oldest = e.at;
    if (e.at >= t - 24 * HOUR) day.push(e);
  }
  return {
    lastHour: summarizeWindow(day.filter((e) => e.at >= t - HOUR)),
    lastDay: summarizeWindow(day),
    since: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

/** Ende einer Datei lesen (höchstens `limit` Bytes); eine angeschnittene erste Zeile wird verworfen. */
function readTail(file: string, limit: number): string[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const lines = buf.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * Zähler aus dem Betriebsprotokoll (aktuelle Datei plus die von Caddy gedrehte, `betrieb*.log`).
 * null, wenn es das Verzeichnis nicht gibt oder keine Datei darin liegt (Entwicklung, Tests) – dann gibt es keinen Befund.
 */
export function readTraffic(now: Date, dir = process.env.SCHULOS_TRAFFIC_LOG_DIR || TRAFFIC_LOG_DIR, limit = TRAFFIC_READ_LIMIT): TrafficStats | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^betrieb.*\.log$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const lines: string[] = [];
  for (const f of files) {
    try {
      lines.push(...readTail(join(dir, f), limit));
    } catch {
      // Datei gerade gedreht oder nicht lesbar – die übrigen reichen
    }
  }
  return summarizeTraffic(lines, now);
}

/** Befund für den HealthReport: viele Serverfehler in der letzten Stunde */
export function trafficProblem(s: TrafficStats | null): HealthProblem | null {
  const h = s?.lastHour;
  if (!h || h.requests < TRAFFIC_5XX_MIN_REQUESTS || h.errorRate === null || h.errorRate < TRAFFIC_5XX_WARN_PERCENT) return null;
  return { level: "warn", key: "zugriffe:5xx", text: `${h.errorRate} % Serverfehler in der letzten Stunde (${h.byClass["5xx"]} von ${h.requests} Anfragen)` };
}
