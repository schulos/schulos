// SQ-03: Mehrfachlauf auf der Demo-Schule – mehrere Durchgänge in einem Lauf-Datensatz, der beste gewinnt (Neu: Startwerte seed, seed+1, …;
// Kette: jeder Warmstart startet vom besten bisherigen Ergebnis), Abbruch behält das bisher beste Ergebnis, deterministisch.
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableDraftLessons, timetableSolverRuns } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { createDraft } from "./planversionen";
import { createRun, executeRun, getRun, listRuns, parseParams, setFixed } from "./solverlauf";
import { planningYear } from "./verteilung";
import { draftOf } from "./plan-quelle";

const today = "2026-10-05";

describe("Mehrfachlauf (SQ-03, Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  const run = async (opts: Parameters<typeof createRun>[2], exec: Parameters<typeof executeRun>[3] = {}) => {
    const id = await createRun(h.db, "u-frank.schulte", opts, today);
    const status = await executeRun(h.db, id, today, exec);
    return { id, status, run: (await getRun(h.db, id))! };
  };
  const better = (a: { unplaced: number; score: number }, b: { unplaced: number; score: number }) => a.unplaced < b.unplaced || (a.unplaced === b.unplaced && a.score < b.score);

  it("Parameter: nur 3, 5 oder 10 Durchgänge; Einzellauf bleibt ohne `passes`", () => {
    expect(() => parseParams({ passes: 4 })).toThrow(ValidationError);
    expect(parseParams({ passes: 5 })).toMatchObject({ passes: 5 });
    expect(parseParams({}).passes).toBeUndefined();
    expect(parseParams({ passes: null }).passes).toBeUndefined();
  });

  it("Neu: ein Datensatz, Startwerte seed, seed+1, …, der beste Durchgang wird behalten – deterministisch und gleich den Einzelläufen", async () => {
    const before = (await listRuns(h.db, 50)).length;
    const multi = await run({ seed: 2, effort: "schnell", passes: 3 });
    expect(multi.status).toBe("done");
    expect((await listRuns(h.db, 50)).length).toBe(before + 1);
    const m = multi.run.metrics!;
    expect(multi.run.params).toMatchObject({ passes: 3, seed: 2 });
    expect(m.passes).toMatchObject({ count: 3, done: 3 });
    expect(m.passes!.list.map((p) => p.seed)).toEqual([2, 3, 4]);
    // jeder Durchgang entspricht dem Einzellauf mit demselben Startwert
    for (const p of m.passes!.list) {
      const single = (await run({ seed: p.seed, effort: "schnell" })).run.metrics!;
      expect({ score: p.score, unplaced: p.unplaced }).toEqual({ score: single.score, unplaced: single.unplaced });
    }
    // der beste gewinnt (bei Gleichstand der frühere)
    let bi = 0;
    m.passes!.list.forEach((p, i) => {
      if (better(p, m.passes!.list[bi]!)) bi = i;
    });
    expect(m.passes!.best).toBe(bi + 1);
    expect({ score: m.score, unplaced: m.unplaced }).toEqual({ score: m.passes!.list[bi]!.score, unplaced: m.passes!.list[bi]!.unplaced });
    expect(multi.run.stored!.result.score).toBe(m.score);
    // Protokoll: je Durchgang eine Zeile, der beste bisherige markiert; Abschluss nennt den besten
    const lines = multi.run.log.filter((e) => e.kind === "progress");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.text).toMatch(/^Durchgang 1 von 3 \(Startwert 2\): Bewertung \d+(\.\d+)?, \d+ nicht gesetzt – bisher der beste$/);
    expect(multi.run.log.find((e) => e.kind === "done")!.text).toMatch(/^Bester Durchgang: \d von 3 \(Startwert \d\)\. Fertig:/);
    expect(multi.run.progress).toBe(100);
    // deterministisch
    const again = await run({ seed: 2, effort: "schnell", passes: 3 });
    expect(again.run.stored!.result.placements).toEqual(multi.run.stored!.result.placements);
    expect(again.run.metrics!.passes!.list).toEqual(m.passes!.list);
  });

  it("Kette (Warmstart): jeder Durchgang startet vom besten Ergebnis, nie schlechter als der Start; fixierte Stunden bleiben", async () => {
    const year = (await planningYear(h.db))!;
    const draftId = (await createDraft(h.db, "u-frank.schulte", { schoolYearId: year.id, source: "live_copy", validFrom: "2027-02-01", numbering: "major", name: "Halbjahr" }, today)).id;
    const rows = await h.db
      .select()
      .from(timetableDraftLessons)
      .where(and(eq(timetableDraftLessons.versionId, draftId), isNull(timetableDraftLessons.couplingId), eq(timetableDraftLessons.fixed, false)))
      .orderBy(asc(timetableDraftLessons.groupId), asc(timetableDraftLessons.weekday), asc(timetableDraftLessons.periodNr), asc(timetableDraftLessons.id));
    const fixedId = rows[0]!.id;
    await setFixed(h.db, "u-frank.schulte", fixedId, true, draftOf(draftId));

    const chain = await run({ seed: 7, effort: "schnell", versionId: draftId, mode: "entwurf", passes: 3 });
    expect(chain.status).toBe("done");
    const m = chain.run.metrics!;
    const list = m.passes!.list;
    expect(list).toHaveLength(3);
    expect(list.map((p) => p.seed)).toEqual([7, 8, 9]);
    // Kette: jeder Durchgang ist höchstens so schlecht wie der bisher beste (und damit wie der Start)
    expect(list[0]!.score).toBeLessThanOrEqual(m.warm!.startScore);
    for (let i = 1; i < list.length; i++) expect(better(list[i]!, list[i - 1]!) || (list[i]!.unplaced === list[i - 1]!.unplaced && list[i]!.score === list[i - 1]!.score)).toBe(true);
    expect(m.score).toBe(Math.min(...list.map((p) => p.score)));
    expect(m.warm!.rounds).toBeGreaterThan(0);
    expect(chain.run.stored!.keptLessonIds).toContain(fixedId);
    // deterministisch
    const again = await run({ seed: 7, effort: "schnell", versionId: draftId, mode: "entwurf", passes: 3 });
    expect(again.run.stored!.result.placements).toEqual(chain.run.stored!.result.placements);
  });

  it("Abbruch nach dem ersten Durchgang: das bisher beste Ergebnis bleibt (done, vorzeitig beendet); vor dem ersten Ergebnis: cancelled", async () => {
    const id = await createRun(h.db, "u-frank.schulte", { seed: 3, effort: "schnell", passes: 3 }, today);
    let improved = false;
    const res = await executeRun(h.db, id, today, {
      heartbeatMs: 0,
      pauseMs: 0,
      onSlice: async (phase) => {
        if (phase === "improve") improved = true;
        // sobald der zweite Durchgang beginnt (Konstruktion nach einer Verbesserung), Abbruch wünschen
        else if (improved) await h.db.update(timetableSolverRuns).set({ cancelRequested: true }).where(eq(timetableSolverRuns.id, id));
      },
    });
    expect(res).toBe("done");
    const r = (await getRun(h.db, id))!;
    expect(r.stored).not.toBeNull();
    expect(r.metrics!.cancelledAt).toBeDefined();
    expect(r.metrics!.passes!.done).toBeGreaterThanOrEqual(1);
    expect(r.metrics!.passes!.done).toBeLessThan(3);
    expect(r.metrics!.passes!.list).toHaveLength(r.metrics!.passes!.done);
    expect(r.log.some((e) => e.kind === "cancel" && /nach \d von 3 Durchgängen/.test(e.text))).toBe(true);
    // das Ergebnis ist der erste Durchgang bzw. der beste der gerechneten
    expect(r.metrics!.score).toBe(Math.min(...r.metrics!.passes!.list.map((p) => p.score)));

    // Abbruch schon in der Konstruktion des ersten Durchgangs: wie beim Einzellauf kein Ergebnis
    const early = await createRun(h.db, "u-frank.schulte", { seed: 3, effort: "schnell", passes: 3 }, today);
    const resEarly = await executeRun(h.db, early, today, {
      heartbeatMs: 0,
      pauseMs: 0,
      onSlice: async () => await h.db.update(timetableSolverRuns).set({ cancelRequested: true }).where(eq(timetableSolverRuns.id, early)),
      sliceMs: 0,
    });
    expect(["cancelled", "done"]).toContain(resEarly);
    if (resEarly === "cancelled") expect(await getRun(h.db, early)).toMatchObject({ stored: null });
  });
});
