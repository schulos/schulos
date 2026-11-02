import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/core/db/testing";
import { collectHealth } from "./health";
import { parseAccessLine, readTraffic, summarizeTraffic, trafficProblem } from "./zugriffe";

const now = new Date("2026-11-02T10:00:00Z");
const sec = (d: Date) => d.getTime() / 1000;
/** so schreibt Caddy eine Zeile, nachdem der Filter `request`, `resp_headers` und `user_id` entfernt hat */
const line = (minutesAgo: number, status: number, durationS = 0.01) =>
  JSON.stringify({ level: "info", ts: sec(now) - minutesAgo * 60, logger: "http.log.access.betrieb", msg: "handled request", bytes_read: 0, duration: durationS, size: 512, status });

describe("Betriebsprotokoll auswerten (BM-05)", () => {
  it("liest nur Zeit, Status und Dauer; Unsinn ergibt null", () => {
    expect(parseAccessLine(line(0, 200, 0.25))).toEqual({ at: now.getTime(), status: 200, durationMs: 250 });
    expect(parseAccessLine("")).toBeNull();
    expect(parseAccessLine("kein json")).toBeNull();
    expect(parseAccessLine("{kaputt")).toBeNull();
    expect(parseAccessLine(JSON.stringify({ ts: 1, status: 999 }))).toBeNull();
    expect(parseAccessLine(JSON.stringify({ ts: "x", status: 200 }))).toBeNull();
    // fehlende Dauer zählt als 0
    expect(parseAccessLine(JSON.stringify({ ts: 1, status: 404 }))).toEqual({ at: 1000, status: 404, durationMs: 0 });
  });

  it("Zähler je Statusklasse, 5xx-Anteil und Perzentile für letzte Stunde und 24 h; Älteres und Zukunft zählen nicht", () => {
    const lines = [
      ...Array.from({ length: 8 }, (_, i) => line(5 + i, 200, (i + 1) / 100)), // 10…80 ms
      line(10, 302, 0.005),
      line(20, 404, 0.002),
      line(30, 503, 1.5),
      line(120, 200, 0.02), // vor 2 h: nur im Tag
      line(60 * 30, 500, 0.1), // vor 30 h: weder Stunde noch Tag, aber „seit“
      line(60 * 50, 200), // älter als 48 h: ignoriert
      line(-10, 200), // Zukunft: ignoriert
      "",
      "Müll",
    ];
    const s = summarizeTraffic(lines, now);
    expect(s.lastHour).toEqual({ requests: 11, byClass: { "2xx": 8, "3xx": 1, "4xx": 1, "5xx": 1 }, errorRate: 9.1, latencyMs: { p50: 40, p95: 1500, p99: 1500 } });
    expect(s.lastDay).toMatchObject({ requests: 12, byClass: { "2xx": 9, "3xx": 1, "4xx": 1, "5xx": 1 }, errorRate: 8.3 });
    expect(s.since).toBe(new Date(now.getTime() - 30 * 3_600_000).toISOString());
  });

  it("leeres Protokoll: Nullen, keine Perzentile", () => {
    expect(summarizeTraffic([], now)).toEqual({
      lastHour: { requests: 0, byClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, errorRate: null, latencyMs: null },
      lastDay: { requests: 0, byClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, errorRate: null, latencyMs: null },
      since: null,
    });
  });

  it("Befund erst ab 5 % Serverfehlern und mindestens 20 Anfragen in der letzten Stunde", () => {
    const mk = (ok: number, bad: number) => summarizeTraffic([...Array.from({ length: ok }, () => line(1, 200)), ...Array.from({ length: bad }, () => line(1, 502))], now);
    expect(trafficProblem(null)).toBeNull();
    expect(trafficProblem(mk(10, 5))).toBeNull(); // zu wenige Anfragen
    expect(trafficProblem(mk(96, 4))).toBeNull(); // 4 %
    expect(trafficProblem(mk(95, 5))).toEqual({ level: "warn", key: "zugriffe:5xx", text: "5 % Serverfehler in der letzten Stunde (5 von 100 Anfragen)" });
  });

  describe("Dateien", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "schulos-betrieb-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("kein Verzeichnis oder keine Datei → null; aktuelle und gedrehte Datei zusammen; fremde Dateien bleiben unberührt", () => {
      expect(readTraffic(now, path.join(dir, "fehlt"))).toBeNull();
      expect(readTraffic(now, dir)).toBeNull();
      writeFileSync(path.join(dir, "betrieb.log"), `${line(1, 200)}\n${line(2, 500)}\n`);
      writeFileSync(path.join(dir, "betrieb-2026-11-01T10-00-00.000.log"), `${line(60 * 20, 200)}\n`);
      // das IP-haltige CrowdSec-Log läge nie hier – und würde auch nicht gelesen
      writeFileSync(path.join(dir, "access.log"), `${line(1, 500)}\n`);
      const s = readTraffic(now, dir)!;
      expect(s.lastHour.requests).toBe(2);
      expect(s.lastDay.requests).toBe(3);
    });

    it("liest vom Ende höchstens das Limit und verwirft die angeschnittene erste Zeile", () => {
      const lines = Array.from({ length: 50 }, (_, i) => line(i % 30, 200));
      writeFileSync(path.join(dir, "betrieb.log"), `${lines.join("\n")}\n`);
      const one = Buffer.byteLength(`${lines[0]}\n`);
      const s = readTraffic(now, dir, one * 10 + 5)!;
      expect(s.lastHour.requests).toBe(10);
    });

    it("collectHealth übernimmt die Zähler und den Befund", async () => {
      const h = await createTestDb();
      try {
        const traffic = summarizeTraffic([...Array.from({ length: 18 }, () => line(1, 200)), line(1, 500), line(1, 500)], now);
        const r = await collectHealth(h.db, {
          system: null,
          backup: { paired: true, health: "ok", lastOkAt: now, lastRun: null, contactError: null, lastContactAt: now, runningSince: null, restoreRequest: null, lastRestore: null },
          now,
          outbox: { pending: 0, sent: 0, failed: 0, oldestPending: null },
          traffic,
        });
        expect(r.traffic).toEqual(traffic);
        expect(r.problems.map((p) => p.key)).toEqual(["zugriffe:5xx"]);
        expect(r.level).toBe("warn");
      } finally {
        await h.close();
      }
    });
  });
});
