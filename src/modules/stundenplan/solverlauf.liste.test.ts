import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { schoolYears, timetableSolverRuns, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { canDeleteRun, isUndoable, listRunSummaries, precheckOf, runLiveStates, type RunLogEntry } from "./solverlauf";

// SP-07: Historie ohne Ergebnis-JSON, Live-Zustand für die Anzeige ohne Neuladen, Vorprüfung aus dem Protokoll.

describe("Solver-Läufe: Historie und Live-Zustand", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(schoolYears).values([
      { id: "y1", name: "2026/27", startsOn: "2026-08-01", endsOn: "2027-07-31", isCurrent: true },
      { id: "y0", name: "2025/26", startsOn: "2025-08-01", endsOn: "2026-07-31" },
    ]);
    await h.db.insert(users).values({ id: "u-plan", username: "plan", email: "plan@example.org", name: "Planung Test", role: "lehrkraft" });
    const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 8, m));
    await h.db.insert(timetableSolverRuns).values([
      {
        id: "r-done",
        schoolYearId: "y1",
        status: "done",
        progress: 100,
        createdBy: "u-plan",
        createdAt: at(1),
        label: "Variante A",
        params: { effort: "normal", seed: 3, preset: "raumtreu", weights: {} },
        metrics: { score: 120, unplaced: 1 },
        result: { result: { placements: [] }, units: [], keptLessonIds: [], refYmd: "2026-10-20" },
        log: [{ at: "x", kind: "done", text: "Fertig" }],
      },
      {
        id: "r-run",
        schoolYearId: "y1",
        status: "running",
        progress: 42,
        createdAt: at(2),
        heartbeatAt: at(3),
        log: [
          { at: "x", kind: "start", text: "Berechnung gestartet" },
          { at: "y", kind: "progress", text: "40 % – Bewertung 312" },
        ],
      },
      { id: "r-old", schoolYearId: "y0", status: "cancelled", createdAt: at(0) },
    ]);
  });
  afterAll(() => h.close());

  it("listRunSummaries: neueste zuerst, ohne Ergebnis, mit Name der startenden Person und Filtern", async () => {
    const all = await listRunSummaries(h.db);
    expect(all.map((r) => r.id)).toEqual(["r-run", "r-done", "r-old"]);
    const done = all.find((r) => r.id === "r-done")!;
    expect(done).toMatchObject({ hasResult: true, createdByName: "Planung Test", label: "Variante A", metrics: { score: 120, unplaced: 1 } });
    expect(done.params?.preset).toBe("raumtreu");
    expect("stored" in done || "log" in done).toBe(false);
    expect(all.find((r) => r.id === "r-run")).toMatchObject({ hasResult: false, createdByName: null });
    expect((await listRunSummaries(h.db, { schoolYearId: "y1" })).map((r) => r.id)).toEqual(["r-run", "r-done"]);
    expect((await listRunSummaries(h.db, { status: ["cancelled", "failed"] })).map((r) => r.id)).toEqual(["r-old"]);
    expect(await listRunSummaries(h.db, { limit: 1 })).toHaveLength(1);
  });

  it("runLiveStates: Status, Fortschritt, letzter Protokolleintrag; unbekannte/ungültige IDs fallen weg", async () => {
    const states = await runLiveStates(h.db, ["r-run", "r-done", "gibt-es-nicht", "'; drop table x; --", "r-run"]);
    expect(states).toHaveLength(2);
    const run = states.find((s) => s.id === "r-run")!;
    expect(run).toMatchObject({ status: "running", progress: 42, cancelRequested: false, note: "40 % – Bewertung 312" });
    expect(run.heartbeatAt).toBe("2026-10-20T08:03:00.000Z");
    expect(states.find((s) => s.id === "r-done")).toMatchObject({ status: "done", note: "Fertig", heartbeatAt: null });
    expect(await runLiveStates(h.db, [])).toEqual([]);
    expect((await runLiveStates(h.db, ["r-old"]))[0]!.note).toBeNull();
  });

  it("precheckOf / canDeleteRun", () => {
    const findings = [{ severity: "error", kind: "teacher", id: "t1", label: "LIN", demand: 30, free: 25, message: "LIN: 30 Stunden, 25 Slots frei" }];
    const log: RunLogEntry[] = [
      { at: "a", kind: "start", text: "s" },
      { at: "b", kind: "precheck", text: "Vorprüfung", data: { findings } },
    ];
    expect(precheckOf(log)).toEqual(findings);
    expect(precheckOf([{ at: "a", kind: "precheck", text: "Vorprüfung: Bedarf passt" }])).toEqual([]);
    expect(precheckOf([{ at: "a", kind: "queued", text: "q" }])).toBeNull();
    const today = "2026-10-20";
    expect(canDeleteRun({ status: "running", appliedFrom: null, undo: null }, today)).toBe(false);
    for (const status of ["queued", "done", "failed", "cancelled", "applied"] as const) expect(canDeleteRun({ status, appliedFrom: null, undo: null }, today)).toBe(true);
    // SP-09: übernommen mit Rücknahme-Daten und Stichtag in der Zukunft → zurücknehmbar, nicht löschbar; ab dem Stichtag bzw. ohne Daten löschbar
    const undo = { ended: [], deleted: [], removedSubstitutions: 0 };
    expect(isUndoable({ status: "applied", appliedFrom: "2026-11-02", undo }, today)).toBe(true);
    expect(canDeleteRun({ status: "applied", appliedFrom: "2026-11-02", undo }, today)).toBe(false);
    expect(isUndoable({ status: "applied", appliedFrom: "2026-10-20", undo }, today)).toBe(false);
    expect(canDeleteRun({ status: "applied", appliedFrom: "2026-10-20", undo }, today)).toBe(true);
    expect(isUndoable({ status: "applied", appliedFrom: "2026-11-02", undo: null }, today)).toBe(false);
    expect(isUndoable({ status: "done", appliedFrom: "2026-11-02", undo }, today)).toBe(false);
  });
});
