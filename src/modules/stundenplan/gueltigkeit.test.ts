// SP2-09 (SP-G-07): Lehrauftrag mit Gültigkeit – Verteilung und Solver am Stichtag, Übernahme bis `valid_until`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { timetableAssignments, timetableLessons, timetableSolverRuns } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { clipValidity } from "./setzhilfe";
import { solverInputFromDb } from "./solver-input";
import { applyRun, createRun, executeRun, getRun, parseParams } from "./solverlauf";
import { activeOn, createAssignment, distribution, listAssignments, planningYear, updateAssignment, validityOverlaps, type Assignment } from "./verteilung";

const today = "2026-10-05";

describe("Gültigkeit (rein)", () => {
  const v = (validFrom: string | null, validUntil: string | null) => ({ validFrom, validUntil });
  it("activeOn und validityOverlaps", () => {
    expect(activeOn(v(null, null), "2027-03-01")).toBe(true);
    expect(activeOn(v("2027-02-01", null), "2027-01-31")).toBe(false);
    expect(activeOn(v(null, "2027-01-31"), "2027-01-31")).toBe(true);
    expect(activeOn(v(null, "2027-01-31"), "2027-02-01")).toBe(false);
    expect(validityOverlaps(v(null, "2027-01-31"), v("2027-02-01", null))).toBe(false);
    expect(validityOverlaps(v(null, "2027-02-01"), v("2027-02-01", null))).toBe(true);
    expect(validityOverlaps(v(null, null), v("2027-02-01", "2027-03-01"))).toBe(true);
  });

  it("clipValidity: Zeitraum der Setzhilfe ∩ Lehrauftrag", () => {
    expect(clipValidity({ validFrom: "2026-08-01", validUntil: "2027-07-31" }, {})).toEqual({ validFrom: "2026-08-01", validUntil: "2027-07-31" });
    expect(clipValidity({ validFrom: "2026-08-01", validUntil: "2027-07-31" }, v("2027-02-01", null))).toEqual({ validFrom: "2027-02-01", validUntil: "2027-07-31" });
    expect(clipValidity({ validFrom: "2026-11-02", validUntil: null }, v(null, "2027-01-31"))).toEqual({ validFrom: "2026-11-02", validUntil: "2027-01-31" });
  });

  it("parseParams: Planungsstand nur, wenn angegeben (Läufe ohne bleiben wie vor SP2-09)", () => {
    expect(parseParams({})).not.toHaveProperty("refYmd");
    expect(parseParams({ refYmd: "2027-02-15" }).refYmd).toBe("2027-02-15");
    expect(() => parseParams({ refYmd: "15.02.2027" })).toThrow(ValidationError);
  });
});

describe("Lehrauftrag mit Gültigkeit (Demo-Schule)", () => {
  let h: DbHandle;
  let year: NonNullable<Awaited<ReturnType<typeof planningYear>>>;
  let first: Assignment; // gilt nur im 1. Halbjahr
  let secondId: string; // gilt erst ab dem 2. Halbjahr

  beforeAll(async () => {
    h = await createSeededTestDb();
    year = (await planningYear(h.db))!;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("ohne Gültigkeitsangaben: Solver-Eingabe hängt nicht vom Stichtag ab", async () => {
    const a = await solverInputFromDb(h.db, year, today);
    const b = await solverInputFromDb(h.db, year, "2027-03-01");
    expect(b.units).toEqual(a.units);
  });

  it("Pflege: Gültigkeit im Schuljahr, ab ≤ bis; derselbe Auftrag in getrennten Zeiträumen ist kein Doppel", async () => {
    const list = await listAssignments(h.db, year.id);
    first = list.find((a) => a.groups[0]?.id === "g-7b" && a.subjectId === "D" && !a.bandId)!;
    expect(first).toBeDefined();
    const base = { schoolYearId: year.id, groupId: first.groups[0]!.id, subjectId: first.subjectId, hours: first.hours, teacherIds: first.teachers.map((t) => t.id), doubleLessons: first.doubleLessons, roomId: first.roomId, note: first.note };
    await expect(updateAssignment(h.db, "u-admin", first.id, { ...base, validFrom: "2026-07-01" })).rejects.toMatchObject({ fieldErrors: { validFrom: "muss im Schuljahr liegen" } });
    await expect(updateAssignment(h.db, "u-admin", first.id, { ...base, validFrom: "2027-02-01", validUntil: "2027-01-31" })).rejects.toMatchObject({
      fieldErrors: { validUntil: "„gültig bis“ liegt vor „gültig ab“" },
    });
    await updateAssignment(h.db, "u-admin", first.id, { ...base, validUntil: "2027-01-31" });
    // gleiche Gruppe, gleiches Fach, gleiche Lehrkraft – überschneidend: Doppel; ab dem 2. Halbjahr: erlaubt
    await expect(createAssignment(h.db, "u-admin", { ...base, validFrom: "2027-01-31" })).rejects.toBeInstanceOf(ValidationError);
    secondId = await createAssignment(h.db, "u-admin", { ...base, hours: 2, doubleLessons: 0, validFrom: "2027-02-01" });
  });

  it("Verteilung am Stichtag: was dann nicht gilt, steht unter „otherTime“ und zählt nirgends", async () => {
    const now = await distribution(h.db, year, today);
    expect(now.assignments.some((a) => a.id === first.id)).toBe(true);
    expect(now.otherTime.map((a) => a.id)).toEqual([secondId]);
    const later = await distribution(h.db, year, "2027-03-01");
    expect(later.assignments.some((a) => a.id === secondId)).toBe(true);
    expect(later.otherTime.map((a) => a.id)).toEqual([first.id]);
    const g = (d: typeof now) => d.groups.find((x) => x.id === first.groups[0]!.id)!.assigned;
    expect(g(now) - g(later)).toBe(first.hours - 2);
    // Solver-Eingabe am Stichtag: nur die dann gültigen Lehraufträge
    const ids = async (ymd: string) => new Set((await solverInputFromDb(h.db, year, ymd)).units.flatMap((u) => u.parts.map((p) => p.assignmentId)));
    expect((await ids(today)).has(secondId)).toBe(false);
    const feb = await ids("2027-03-01");
    expect(feb.has(secondId)).toBe(true);
    expect(feb.has(first.id)).toBe(false);
  });

  it("Übernahme: Stunden enden mit ihrem Lehrauftrag; Läufe für später erst ab dessen Beginn; abgelaufene entfallen", async () => {
    const run = await createRun(h.db, "u-admin", { seed: 5, effort: "schnell" }, today);
    await executeRun(h.db, run, today, { sliceMs: 2 });
    expect((await getRun(h.db, run))!.status).toBe("done");
    const res = await applyRun(h.db, "u-admin", run, "2026-11-02", today);
    expect(res.expired).toBeUndefined();
    const own = await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, run));
    const deutsch7b = own.filter((l) => l.groupId === first.groups[0]!.id && l.subjectId === "D");
    expect(deutsch7b).toHaveLength(first.hours);
    expect(deutsch7b.every((l) => l.validUntil === "2027-01-31")).toBe(true);
    expect(own.filter((l) => l.validUntil === year.endsOn).length).toBe(own.length - first.hours);

    // Lauf für das 2. Halbjahr: Übernahme vorher → Fehler, ab dem 1.2. → nur der neue Auftrag (der alte gilt dann nicht)
    const feb = await createRun(h.db, "u-admin", { seed: 5, effort: "schnell", refYmd: "2027-02-01" }, today);
    await executeRun(h.db, feb, today, { sliceMs: 2 });
    const febRun = (await getRun(h.db, feb))!;
    expect(febRun.params!.refYmd).toBe("2027-02-01");
    expect(febRun.stored!.refYmd).toBe("2027-02-01");
    expect(febRun.log.find((e) => e.kind === "start")!.text).toContain("Lehraufträge am");
    await expect(applyRun(h.db, "u-admin", feb, "2026-12-01", today)).rejects.toMatchObject({ fieldErrors: { from: expect.stringContaining("gelten erst ab") } });
    await applyRun(h.db, "u-admin", feb, "2027-02-01", today);
    const febLessons = await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, feb));
    expect(febLessons.filter((l) => l.groupId === first.groups[0]!.id && l.subjectId === "D")).toHaveLength(2);
    // die Stunden des 1. Halbjahrs bleiben bis 31.01. stehen
    const kept = await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.solverRunId, run), isNotNull(timetableLessons.validUntil)));
    expect(kept.filter((l) => l.groupId === first.groups[0]!.id && l.subjectId === "D").every((l) => l.validUntil === "2027-01-31")).toBe(true);

    // Lauf mit dem Stand von heute erst ab dem 2. Halbjahr übernommen: der abgelaufene Auftrag bekommt keine Stunden
    await h.db.delete(timetableAssignments).where(inArray(timetableAssignments.id, [secondId]));
    const late = await createRun(h.db, "u-admin", { seed: 5, effort: "schnell" }, today);
    await executeRun(h.db, late, today, { sliceMs: 2 });
    const r = await applyRun(h.db, "u-admin", late, "2027-03-01", today);
    expect(r.expired).toBe(first.hours);
    const lateLessons = await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, late));
    expect(lateLessons.some((l) => l.groupId === first.groups[0]!.id && l.subjectId === "D")).toBe(false);
    expect((await getRun(h.db, late))!.log.at(-1)!.text).toContain("Lehrauftrag endet vor dem Stichtag");
    await h.db.update(timetableSolverRuns).set({ status: "failed" }).where(sql`${timetableSolverRuns.status} in ('running', 'queued')`);
  });
});
