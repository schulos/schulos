// SP3-02: Diff-Engine `planDiff()` (rein) – Paare über Herkunft und Inhalt, Felder, Kopplung, je Lehrkraft/Klasse; dazu die reinen
// Helfer der Übernahme in den Entwurf (`carryOrigins`) und des Variantenvergleichs (`planGaps`, `compareVersionMetrics`).
import { describe, expect, it } from "vitest";
import { changedFields, planDiff, type DiffLesson } from "./plan-diff";
import { carryOrigins } from "./solverlauf";
import { compareVersionMetrics, planGaps, type PlanMetrics } from "./solververgleich";

const L = (id: string, o: Partial<DiffLesson> = {}): DiffLesson => ({
  id,
  groupId: "7a",
  subjectId: "D",
  teacherId: "t1",
  roomId: "101",
  weekday: 0,
  periodNr: 1,
  week: "all",
  couplingId: null,
  ...o,
});

describe("planDiff", () => {
  it("Entwurf ↔ gültig: über die Herkunft unverändert, geändert (mit Feldern), neu, entfällt", () => {
    const live = [L("a"), L("b", { periodNr: 2, subjectId: "M" }), L("c", { periodNr: 3, subjectId: "E", teacherId: "t2" }), L("d", { periodNr: 4, subjectId: "SP" })];
    const draft = [
      L("x1", { originLessonId: "a" }),
      // verschoben und anderer Raum
      L("x2", { originLessonId: "b", subjectId: "M", weekday: 1, periodNr: 5, roomId: "102" }),
      // andere Lehrkraft
      L("x3", { originLessonId: "c", periodNr: 3, subjectId: "E", teacherId: "t3" }),
      // neu (ohne Herkunft)
      L("x4", { periodNr: 6, subjectId: "KU", teacherId: "t4", roomId: null }),
    ];
    const d = planDiff(live, draft);
    expect(d.counts).toEqual({ unchanged: 1, changed: 2, added: 1, removed: 1 });
    const byAfter = new Map(d.entries.filter((e) => e.after).map((e) => [e.after!.id, e]));
    expect(byAfter.get("x1")).toMatchObject({ kind: "unchanged", before: { id: "a" }, changes: [] });
    expect(byAfter.get("x2")).toMatchObject({ kind: "changed", before: { id: "b" }, changes: ["slot", "room"] });
    expect(byAfter.get("x3")).toMatchObject({ kind: "changed", before: { id: "c" }, changes: ["teacher"] });
    expect(byAfter.get("x4")).toMatchObject({ kind: "added", before: null });
    expect(d.entries.find((e) => e.kind === "removed")!.before!.id).toBe("d");
    // je Lehrkraft: die alte und die neue Lehrkraft sehen die Änderung; Unverändertes erscheint nicht
    expect(d.byTeacher.get("t1")!.map((e) => e.kind).sort()).toEqual(["changed", "removed"]);
    expect(d.byTeacher.get("t2")!.map((e) => e.kind)).toEqual(["changed"]);
    expect(d.byTeacher.get("t3")!.map((e) => e.kind)).toEqual(["changed"]);
    expect(d.byTeacher.get("t4")!.map((e) => e.kind)).toEqual(["added"]);
    expect(d.byGroup.get("7a")).toHaveLength(4);
    // sortiert nach Tag/Stunde (nachher, sonst vorher)
    const at = (e: (typeof d.entries)[number]) => (e.after ?? e.before)!;
    expect(d.entries.map((e) => [at(e).weekday, at(e).periodNr])).toEqual([...d.entries.map((e) => [at(e).weekday, at(e).periodNr])].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!));
  });

  it("ohne Herkunft: gleicher Inhalt ist unverändert, sonst entfällt/neu (kein Raten über „ähnliche“ Stunden)", () => {
    const d = planDiff([L("a"), L("b", { periodNr: 2 })], [L("y", { periodNr: 2 }), L("z", { periodNr: 3 })]);
    expect(d.counts).toEqual({ unchanged: 1, changed: 0, added: 1, removed: 1 });
    expect(d.entries.find((e) => e.kind === "unchanged")).toMatchObject({ before: { id: "b" }, after: { id: "y" } });
  });

  it("Varianten: zwei Entwurfsstunden derselben Herkunft gehören zusammen; bei mehreren Kandidaten gewinnt gleicher Inhalt", () => {
    const a = [L("v1", { originLessonId: "o1" }), L("v2", { originLessonId: "o1", periodNr: 2 })];
    const b = [L("w1", { originLessonId: "o1", periodNr: 2 }), L("w2", { originLessonId: "o1", periodNr: 5 })];
    const d = planDiff(a, b);
    expect(d.entries.find((e) => e.after?.id === "w1")).toMatchObject({ kind: "unchanged", before: { id: "v2" } });
    expect(d.entries.find((e) => e.after?.id === "w2")).toMatchObject({ kind: "changed", before: { id: "v1" }, changes: ["slot"] });
    // umgekehrt (gültig ↔ Entwurf): Herkunft der vorherigen Seite zeigt auf die Stunde der nachherigen
    expect(planDiff([L("x", { originLessonId: "live" })], [L("live")]).counts.unchanged).toBe(1);
  });

  it("Kopplung: gleich, wenn dieselben Partner zusammen liegen (unabhängig von der Kopplungs-id); aufgelöst/neu ist eine Änderung", () => {
    const live = [L("a", { couplingId: "k1" }), L("b", { couplingId: "k1", groupId: "7b", roomId: "102" }), L("c", { periodNr: 3 })];
    const same = [L("x", { originLessonId: "a", couplingId: "neu" }), L("y", { originLessonId: "b", couplingId: "neu", groupId: "7b", roomId: "102" }), L("z", { originLessonId: "c", periodNr: 3 })];
    expect(planDiff(live, same).counts).toEqual({ unchanged: 3, changed: 0, added: 0, removed: 0 });
    // Teil b fällt weg → a ist nicht mehr gekoppelt
    const split = [L("x", { originLessonId: "a" }), L("z", { originLessonId: "c", periodNr: 3 })];
    const d = planDiff(live, split);
    expect(d.entries.find((e) => e.after?.id === "x")).toMatchObject({ kind: "changed", changes: ["coupling"] });
    expect(d.counts.removed).toBe(1);
    // neue Kopplung mit c
    const joined = [L("x", { originLessonId: "a", couplingId: "k9" }), L("y", { originLessonId: "b", couplingId: "k9", groupId: "7b", roomId: "102" }), L("z", { originLessonId: "c", couplingId: "k9", periodNr: 3 })];
    expect(planDiff(live, joined).counts.changed).toBe(3);
  });

  it("leere Pläne und unveränderter Plan; Felder einzeln", () => {
    expect(planDiff([], [])).toMatchObject({ entries: [], counts: { unchanged: 0, changed: 0, added: 0, removed: 0 } });
    const plan = [L("a"), L("b", { periodNr: 2 })];
    const d = planDiff(plan, plan);
    expect(d.counts.unchanged).toBe(2);
    expect(d.byTeacher.size).toBe(0);
    expect(changedFields(L("a"), L("b", { subjectId: "M", groupId: "7b", week: "A", teacherId: null, roomId: null }))).toEqual(["subject", "teacher", "room", "group", "week"]);
  });
});

describe("carryOrigins (Übernahme in den Entwurf)", () => {
  const P = (o: Partial<{ groupId: string; subjectId: string; teacherId: string | null; weekday: number; periodNr: number }>) => ({ groupId: "7a", subjectId: "D", teacherId: "t1", weekday: 0, periodNr: 1, ...o });
  it("gleicher Slot vor gleicher Lehrkraft vor gleichem Fach; jede Herkunft höchstens einmal; ohne Herkunft nichts", () => {
    const replaced = [
      { ...P({ periodNr: 2 }), originLessonId: "o-slot" },
      { ...P({ periodNr: 4 }), originLessonId: "o-teacher" },
      { ...P({ teacherId: "t9", periodNr: 6 }), originLessonId: "o-subject" },
      { ...P({ subjectId: "M" }), originLessonId: null },
    ];
    const fresh = [P({ periodNr: 3 }), P({ periodNr: 2 }), P({ teacherId: "t5", periodNr: 1 }), P({ periodNr: 7 }), P({ subjectId: "M" })];
    expect(carryOrigins(fresh, replaced)).toEqual(["o-teacher", "o-slot", "o-subject", null, null]);
  });
});

describe("Variantenvergleich (rein)", () => {
  it("planGaps: Hohlstunden je Lehrkraft und Klasse", () => {
    const lessons = [
      { groupId: "7a", teacherId: "t1", weekday: 0, periodNr: 1 },
      { groupId: "7a", teacherId: "t1", weekday: 0, periodNr: 4 },
      { groupId: "7b", teacherId: "t2", weekday: 0, periodNr: 1 },
      { groupId: "7b", teacherId: "t2", weekday: 0, periodNr: 3 },
      { groupId: "kurs", teacherId: "t2", weekday: 1, periodNr: 1 },
      { groupId: "kurs", teacherId: null, weekday: 1, periodNr: 5 },
    ];
    expect(planGaps(lessons, [1, 2, 3, 4, 5, 6], new Set(["7a", "7b"]))).toEqual({ teacherTotal: 3, teacherMax: 2, classTotal: 3, classMax: 2 });
    expect(planGaps([], [1, 2], new Set())).toEqual({ teacherTotal: 0, teacherMax: 0, classTotal: 0, classMax: 0 });
  });

  it("compareVersionMetrics: Bestwert, Delta zur ersten Version, Wochenstunden ungewertet", () => {
    const m = (o: Partial<PlanMetrics>): PlanMetrics => ({
      lessons: 100,
      withoutTeacher: 0,
      gaps: { teacherTotal: 5, teacherMax: 2, classTotal: 1, classMax: 1 },
      diag: { gaps: 1, subjectDay: 0, room: 0 },
      errors: 0,
      warnings: 2,
      ...o,
    });
    const rows = compareVersionMetrics([m({}), m({ lessons: 98, gaps: { teacherTotal: 3, teacherMax: 1, classTotal: 1, classMax: 1 }, warnings: 4 })]);
    expect(rows.find((r) => r.key === "lessons")).toMatchObject({ values: [100, 98], best: [], deltas: [0, -2] });
    expect(rows.find((r) => r.key === "teacherTotal")).toMatchObject({ best: [1], deltas: [0, -2] });
    expect(rows.find((r) => r.key === "warnings")).toMatchObject({ best: [0], deltas: [0, 2] });
    expect(rows.find((r) => r.key === "classTotal")!.best).toEqual([]);
    expect(rows.map((r) => r.group)).toEqual(expect.arrayContaining(["gesamt", "hohlstunden", "diagnose"]));
  });
});
