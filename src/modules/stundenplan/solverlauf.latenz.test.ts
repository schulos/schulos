// SP-06 (Q-SP-9): Der Solver rechnet im App-Prozess zeitgeschnitten (~25 ms, dann setImmediate). Dieser Test misst, wie
// lange die Ereignisschleife während eines gründlichen Laufs auf der Demo-Schule höchstens blockiert ist – das ist die
// Verzögerung, die eine gleichzeitige Anfrage im Server schlimmstenfalls erfährt. Zahlen in docs/LASTTEST.md („Solver“).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { createRun, executeRun, getRun } from "./solverlauf";

const today = "2026-10-05";

/** Misst die Verzögerung eines 5-ms-Timers – alles über 5 ms ist Blockade der Ereignisschleife. */
function lagMeter(everyMs = 5) {
  const lags: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - everyMs));
    last = now;
  }, everyMs);
  return {
    stop() {
      clearInterval(timer);
      const sorted = [...lags].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return { samples: lags.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.at(-1) ?? 0 };
    },
  };
}

describe("Solver-Lauf im App-Prozess: Ereignisschleife bleibt frei", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("gründlicher Lauf auf der Demo-Schule: Blockaden der Ereignisschleife p95 unter 100 ms, Maximum unter 300 ms", async () => {
    const id = await createRun(h.db, "u-admin", { seed: 1, effort: "gruendlich" }, today);
    // Ruhe-Referenz (Timer-Jitter des Rechners)
    const idle = lagMeter();
    await new Promise((r) => setTimeout(r, 300));
    const idleStats = idle.stop();
    const meter = lagMeter();
    let slices = 0;
    const t0 = performance.now();
    expect(await executeRun(h.db, id, today, { onSlice: () => slices++ })).toBe("done");
    const ms = performance.now() - t0;
    const stats = meter.stop();
    const run = (await getRun(h.db, id))!;
    console.log(
      `[latenz] gründlich: ${Math.round(ms)} ms, ${slices} Zeitscheiben, ${run.metrics!.steps} Schritte, Bewertung ${run.metrics!.score}; Verzögerung p50 ${stats.p50.toFixed(1)} / p95 ${stats.p95.toFixed(1)} / p99 ${stats.p99.toFixed(1)} / max ${stats.max.toFixed(1)} ms (${stats.samples} Messpunkte; Ruhe p95 ${idleStats.p95.toFixed(1)} / max ${idleStats.max.toFixed(1)} ms)`,
    );
    // gründlich = das Vierfache des Richtwerts (40 Schritte je Einheit)
    expect(run.metrics!.steps).toBe(run.iterations);
    expect(run.metrics!.steps).toBeGreaterThan(4 * 300 * 40);
    expect(slices).toBeGreaterThan(10);
    // 25 ms rechnen je Scheibe plus Datenbankschreiben (PGlite rechnet im selben Thread, im Betrieb ist das PostgreSQL-Wartezeit):
    // lokal p95 ≈ 25 ms, max ≈ 80 ms (Eingabe laden). Unter Last (CI, parallele Testdateien) streut das Maximum stark – es zählt
    // nur, wenn der Rechner in der Ruhemessung ruhig war; p95 muss immer passen.
    expect(stats.p95).toBeLessThan(100);
    if (idleStats.max < 25) expect(stats.max).toBeLessThan(300);
  }, 120_000);
});
