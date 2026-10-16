import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons, timetableSolverRuns } from "@/core/db/schema";
import { tryAcquire } from "@/core/jobs";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { applyRun, createRun, executeRun, executeRunExclusive, failInterruptedRuns, getRun, listRuns, proposalDiagnosis, proposedLessons, setFixed } from "./solverlauf";
import { distribution, planningYear } from "./verteilung";

describe("Solver-Lauf (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("fixierte Stunde bleibt, Lauf mit Fortschritt, Vorschau, Diagnose, Übernahme ab Stichtag", async () => {
    const year = (await planningYear(h.db))!;
    const before = await h.db.select().from(timetableLessons);
    const pin = before.find((l) => l.groupId === "g-7b" && l.subjectId === "D")!;
    await setFixed(h.db, "u-admin", pin.id, true);

    const id = await createRun(h.db, "u-admin", { seed: 3, effort: "schnell" });
    await expect(createRun(h.db, "u-admin", {})).rejects.toBeInstanceOf(ValidationError); // läuft schon
    expect((await getRun(h.db, id))!.status).toBe("running");
    await executeRun(h.db, id, today, "schnell");
    const run = (await getRun(h.db, id))!;
    expect(run).toMatchObject({ status: "done", progress: 100 });
    expect(run.stored!.result.unplaced).toEqual([]);
    expect(run.stored!.keptLessonIds).toContain(pin.id);
    expect((await listRuns(h.db))[0]!.id).toBe(id);

    // Vorschau: so viele Stunden-Zeilen wie heute (die fixierte bleibt, ihr Auftrag hat eine Stunde weniger)
    const proposal = proposedLessons(run.stored!);
    expect(proposal.length + run.stored!.keptLessonIds.length).toBe(before.length);
    // nichts liegt auf dem Slot der fixierten Stunde in der 7b
    expect(proposal.some((l) => l.groupId === "g-7b" && l.weekday === pin.weekday && l.periodNr === pin.periodNr)).toBe(false);
    const diag = await proposalDiagnosis(h.db, run.stored!);
    expect(diag.filter((f) => f.category === "gaps" && f.target.kind === "group").length).toBeLessThanOrEqual(3);

    await expect(applyRun(h.db, "u-admin", id, today, today)).rejects.toBeInstanceOf(ValidationError);
    const from = "2026-11-02";
    const res = await applyRun(h.db, "u-admin", id, from, today);
    expect(res.created).toBe(proposal.length);
    expect(res.ended).toBe(before.length - 1);
    expect((await getRun(h.db, id))!).toMatchObject({ status: "applied", appliedFrom: from });
    await expect(applyRun(h.db, "u-admin", id, from, today)).rejects.toBeInstanceOf(ValidationError);

    // bis zum Vortag gilt der alte Plan, ab Stichtag der neue – jeweils vollständig verplant
    const old = await distribution(h.db, year, "2026-10-30");
    const neu = await distribution(h.db, year, "2026-11-04");
    expect(old.assignments.every((a) => a.planned === a.hours)).toBe(true);
    expect(neu.assignments.every((a) => a.planned === a.hours)).toBe(true);
    expect(neu.unmatched).toEqual([]);
    const [pinned] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, pin.id));
    expect(pinned).toMatchObject({ fixed: true, validUntil: pin.validUntil });
  }, 60_000);

  it("Job-Sperre: belegte Sperre → Lauf scheitert mit Hinweis; Serverneustart bricht rechnende Läufe ab", async () => {
    await h.db.update(timetableSolverRuns).set({ status: "failed" }).where(eq(timetableSolverRuns.status, "running"));
    const a = await createRun(h.db, "u-admin", { seed: 1 });
    expect(await tryAcquire(h.db, "solver", "anderer-prozess", 60_000, new Date())).toBe(true);
    expect(await executeRunExclusive(h.db, a, today, "schnell")).toBe(false);
    expect(await getRun(h.db, a)).toMatchObject({ status: "failed", error: "Es läuft schon eine Berechnung" });

    const b = await createRun(h.db, "u-admin", { seed: 2 });
    expect(await failInterruptedRuns(h.db)).toBe(1);
    expect(await getRun(h.db, b)).toMatchObject({ status: "failed", error: "Abgebrochen: Der Server wurde neu gestartet" });
  });
});
