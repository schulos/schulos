import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { schoolYears, timetableSolverRuns } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import type { RunMetrics } from "./solverlauf";
import {
  compareMetrics,
  isComparable,
  loadComparison,
  parseCompareIds,
  rowOf,
} from "./solververgleich";

// SP-08: Delta-Berechnung, bester Wert je Zeile, Auswahlprüfung (2–3 fertige Läufe desselben Schuljahres).

const metrics = (
  over: Partial<RunMetrics> & { score: number },
): RunMetrics => ({
  breakdown: {
    pref: 0,
    teacherGap: 0,
    classGap: 0,
    subjectTwice: 0,
    roomWish: 0,
    noRoom: 0,
    late: 0,
    teacherDays: 0,
    subjectSpread: 0,
  },
  unplaced: 0,
  units: 100,
  steps: 10,
  improved: 1,
  durationMs: 1000,
  gaps: { teacherTotal: 0, teacherMax: 0, classTotal: 0, classMax: 0 },
  diag: { gaps: 0, subjectDay: 0, room: 0 },
  pauses: 0,
  precheck: { errors: 0, warnings: 0 },
  ...over,
});

describe("Vergleich: Zeilen, Delta, bester Wert", () => {
  it("rowOf: Delta zum ersten Lauf, kleinster Wert ist der beste (auch bei Gleichstand)", () => {
    expect(rowOf("x", "X", "gesamt", [10, 7, 12])).toMatchObject({
      values: [10, 7, 12],
      deltas: [0, -3, 2],
      best: [1],
    });
    expect(rowOf("x", "X", "gesamt", [5, 9, 5]).best).toEqual([0, 2]);
  });

  it("rowOf: sind alle gleich, ist niemand „bester“; nicht gewertete Zeilen (Dauer) haben keinen besten Wert", () => {
    expect(rowOf("x", "X", "gesamt", [4, 4]).best).toEqual([]);
    expect(
      rowOf("d", "Dauer", "lauf", [3000, 1000], false, "ms"),
    ).toMatchObject({ best: [], deltas: [0, -2000], unit: "ms" });
  });

  it("rowOf: Dezimalwerte ohne Gleitkomma-Rauschen", () => {
    expect(rowOf("x", "X", "gesamt", [0.1, 0.3]).deltas).toEqual([0, 0.2]);
  });

  it("compareMetrics: alle Kennzahlen, Kostenposten und Dauer; bester Wert je Zeile", () => {
    const a = metrics({
      score: 300,
      unplaced: 2,
      gaps: { teacherTotal: 5, teacherMax: 2, classTotal: 1, classMax: 1 },
      breakdown: {
        pref: 10,
        teacherGap: 100,
        classGap: 0,
        subjectTwice: 0,
        roomWish: 0,
        noRoom: 0,
        late: 4,
        teacherDays: 0,
        subjectSpread: 0,
      },
    });
    const b = metrics({
      score: 250,
      unplaced: 0,
      durationMs: 4000,
      gaps: { teacherTotal: 8, teacherMax: 3, classTotal: 1, classMax: 1 },
      diag: { gaps: 3, subjectDay: 0, room: 0 },
    });
    const rows = new Map(compareMetrics([a, b]).map((r) => [r.key, r]));
    expect(rows.get("score")).toMatchObject({
      values: [300, 250],
      deltas: [0, -50],
      best: [1],
    });
    expect(rows.get("unplaced")).toMatchObject({ best: [1] });
    expect(rows.get("teacherTotal")).toMatchObject({
      values: [5, 8],
      deltas: [0, 3],
      best: [0],
    });
    expect(rows.get("classTotal")!.best).toEqual([]);
    expect(rows.get("diag-gaps")).toMatchObject({ values: [0, 3], best: [0] });
    expect(rows.get("cost-teacherGap")).toMatchObject({
      values: [100, 0],
      best: [1],
    });
    expect(rows.get("duration")).toMatchObject({
      values: [1000, 4000],
      deltas: [0, 3000],
      best: [],
      unit: "ms",
    });
    expect([...rows.keys()]).toEqual(
      expect.arrayContaining([
        "cost-pref",
        "cost-late",
        "cost-noRoom",
        "diag-room",
      ]),
    );
  });

  it("compareMetrics: drei Läufe, fehlende ältere Felder zählen als 0", () => {
    const old = { score: 9 } as unknown as RunMetrics;
    const rows = new Map(
      compareMetrics([metrics({ score: 5 }), old, metrics({ score: 7 })]).map(
        (r) => [r.key, r],
      ),
    );
    expect(rows.get("score")).toMatchObject({ best: [0], deltas: [0, 4, 2] });
  });
});

describe("Vergleich: Auswahl lesen", () => {
  it("parseCompareIds: Komma-Liste und wiederholte Parameter, ohne Doppelte und Unsinn, Reihenfolge bleibt", () => {
    expect(parseCompareIds("b,a,b, c")).toEqual(["b", "a", "c"]);
    expect(parseCompareIds(["x", "y,z"])).toEqual(["x", "y", "z"]);
    expect(parseCompareIds(undefined)).toEqual([]);
    expect(parseCompareIds("a,../b,,c d")).toEqual(["a"]);
  });

  it("isComparable: nur fertig/übernommen mit Kennzahlen", () => {
    expect(isComparable({ status: "done", metrics: {} })).toBe(true);
    expect(isComparable({ status: "applied", metrics: {} })).toBe(true);
    expect(isComparable({ status: "done", metrics: null })).toBe(false);
    expect(isComparable({ status: "running", metrics: {} })).toBe(false);
    expect(isComparable({ status: "cancelled", metrics: {} })).toBe(false);
  });
});

describe("Vergleich: loadComparison", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(schoolYears).values([
      {
        id: "y1",
        name: "2026/27",
        startsOn: "2026-08-01",
        endsOn: "2027-07-31",
        isCurrent: true,
      },
      {
        id: "y0",
        name: "2025/26",
        startsOn: "2025-08-01",
        endsOn: "2026-07-31",
      },
    ]);
    const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 8, m));
    const mk = (
      id: string,
      schoolYearId: string,
      status: "done" | "applied" | "running" | "cancelled",
      score: number | null,
      m: number,
    ) => ({
      id,
      schoolYearId,
      status,
      createdAt: at(m),
      metrics: score === null ? null : metrics({ score }),
    });
    await h.db
      .insert(timetableSolverRuns)
      .values([
        mk("a", "y1", "done", 300, 1),
        mk("b", "y1", "applied", 250, 2),
        mk("c", "y1", "done", 280, 3),
        mk("d", "y1", "done", 270, 4),
        mk("run", "y1", "running", null, 5),
        mk("off", "y1", "cancelled", null, 6),
        mk("alt", "y0", "done", 100, 0),
      ]);
  });
  afterAll(() => h.close());

  it("liefert die Läufe in der gewählten Reihenfolge mit Zeilen", async () => {
    const r = await loadComparison(h.db, ["c", "a", "b"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.comparison.runs.map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(r.comparison.rows.find((x) => x.key === "score")).toMatchObject({
      values: [280, 300, 250],
      deltas: [0, 20, -30],
      best: [2],
    });
  });

  it("lehnt zu wenige, zu viele, unbekannte, unfertige und fremde Läufe ab", async () => {
    const bad = async (ids: string[]) => {
      const r = await loadComparison(h.db, ids);
      return r.ok ? null : r.problem;
    };
    expect(await bad(["a"])).toMatch(/mindestens 2/);
    expect(await bad(["a", "b", "c", "d"])).toMatch(/höchstens 3/);
    expect(await bad(["a", "gibt-es-nicht"])).toMatch(/nicht gefunden/);
    expect(await bad(["a", "run"])).toMatch(/fertige oder übernommene/);
    expect(await bad(["a", "off"])).toMatch(/fertige oder übernommene/);
    expect(await bad(["a", "alt"])).toMatch(/verschiedenen Schuljahren/);
  });
});
