import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, schoolYears, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteSubject } from "@/modules/verwaltung/stammdaten";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  assignmentsFromTimetable,
  createAssignment,
  deleteAssignment,
  distribution,
  listAssignments,
  matchLessons,
  planningYear,
  referenceDate,
  updateAssignment,
  type AssignmentInput,
  type PlanLesson,
} from "./verteilung";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("matchLessons", () => {
  const lesson = (id: string, groupId: string, subjectId: string, teacherId: string | null, weight = 1): PlanLesson => ({ id, groupId, subjectId, teacherId, weight });

  it("zählt Stunden je Auftrag, A/B-Wochen halb, Rest ohne Auftrag", () => {
    const r = matchLessons(
      [{ id: "a", subjectId: "D", hours: 3, groupIds: ["7a"], teacherIds: ["t1"] }],
      [lesson("1", "7a", "D", "t1"), lesson("2", "7a", "D", "t1", 0.5), lesson("3", "7a", "M", "t1"), lesson("4", "7b", "D", "t1")],
    );
    expect(r.byAssignment.get("a")).toEqual({ planned: 1.5, otherTeacher: false });
    expect(r.unmatched.map((l) => l.id)).toEqual(["3", "4"]);
  });

  it("verteilt auf zwei Aufträge desselben Fachs nach Lehrkraft", () => {
    const r = matchLessons(
      [
        { id: "a", subjectId: "D", hours: 2, groupIds: ["7a"], teacherIds: ["t1"] },
        { id: "b", subjectId: "D", hours: 2, groupIds: ["7a"], teacherIds: ["t2"] },
      ],
      [lesson("1", "7a", "D", "t2"), lesson("2", "7a", "D", "t1"), lesson("3", "7a", "D", "t2")],
    );
    expect(r.byAssignment.get("a")!.planned).toBe(1);
    expect(r.byAssignment.get("b")!.planned).toBe(2);
  });

  it("Kopplung: verplant ist die am wenigsten verplante Gruppe; fremde Lehrkraft wird markiert", () => {
    const r = matchLessons(
      [{ id: "a", subjectId: "REL", hours: 2, groupIds: ["7a", "7b"], teacherIds: ["t1"] }],
      [lesson("1", "7a", "REL", "t1"), lesson("2", "7a", "REL", "t1"), lesson("3", "7b", "REL", "t9")],
    );
    expect(r.byAssignment.get("a")).toEqual({ planned: 1, otherTeacher: true });
  });

  it("Auftrag ohne Lehrkraft nimmt jede Lehrkraft", () => {
    const r = matchLessons([{ id: "a", subjectId: "SP", hours: 1, groupIds: ["7a"], teacherIds: [] }], [lesson("1", "7a", "SP", "t3")]);
    expect(r.byAssignment.get("a")).toEqual({ planned: 1, otherTeacher: false });
  });
});

describe("referenceDate", () => {
  const y = { startsOn: "2026-08-01", endsOn: "2027-07-31" };
  it("grenzt heute auf das Schuljahr ein", () => {
    expect(referenceDate(y, "2026-10-04")).toBe("2026-10-04");
    expect(referenceDate(y, "2026-05-01")).toBe("2026-08-01");
    expect(referenceDate(y, "2028-01-01")).toBe("2027-07-31");
  });
});

describe("Unterrichtsverteilung (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  let year: { id: string; startsOn: string; endsOn: string };
  beforeAll(async () => {
    h = await createSeededTestDb();
    year = (await planningYear(h.db))!;
  });
  afterAll(() => h.close());

  const base = (): AssignmentInput => ({
    schoolYearId: year.id,
    groupIds: ["g-7b"],
    subjectId: "F",
    hours: 4,
    teacherIds: ["u-jana.brandt"],
    doubleLessons: 1,
    roomId: null,
    note: null,
  });

  it("Seed: Lehraufträge passen zum Demo-Plan, Klassen erfüllen die Stundentafel", async () => {
    expect(year.id).toBe("sj-2026-27");
    const d = await distribution(h.db, year, today);
    expect(d.unmatched).toEqual([]);
    expect(d.assignments.length).toBeGreaterThan(100);
    expect(d.assignments.every((a) => a.planned === a.hours && !a.otherTeacher)).toBe(true);
    const g7b = d.groups.find((g) => g.id === "g-7b")!;
    expect(g7b.curriculum).toBeGreaterThan(25);
    expect(g7b).toMatchObject({ assigned: g7b.curriculum, planned: g7b.curriculum });
    const jana = d.teachers.find((t) => t.id === "u-jana.brandt")!;
    expect(jana.assigned).toBe(jana.planned);
    expect(jana.assigned).toBeGreaterThan(0);
    // Doppelstunden aus dem Plan erkannt, nie mehr als die Hälfte der Stunden
    expect(d.assignments.every((a) => a.doubleLessons * 2 <= a.hours)).toBe(true);
    // erneutes Übernehmen legt nichts doppelt an
    expect(await assignmentsFromTimetable(h.db, "u-admin", year, today)).toBe(0);
  });

  it("prüft Eingaben", async () => {
    const used = (await listAssignments(h.db, year.id)).find((a) => a.groups.some((g) => g.id === "g-7b") && a.subjectId === "D")!;
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), groupIds: [] }))).toHaveProperty("groupIds");
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), hours: 0 }))).toHaveProperty("hours");
    expect((await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), hours: 3, doubleLessons: 2 }))).doubleLessons).toMatch(/höchstens 1/);
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), teacherIds: ["u-lea.schaefer"] }))).toHaveProperty("teacherIds");
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), groupIds: ["g-7b", "nope"] }))).toHaveProperty("groupIds");
    // gleiches Fach, gleiche Gruppe, gleiche Lehrkraft → doppelt
    const dup = await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), subjectId: "D", teacherIds: used.teachers.map((t) => t.id) }));
    expect(dup.subjectId).toMatch(/hat schon einen Lehrauftrag Deutsch/);
  });

  it("legt an, ändert und löscht – Soll/verplant je Klasse und Lehrkraft", async () => {
    const before = await distribution(h.db, year, today);
    const id = await createAssignment(h.db, "u-admin", { ...base(), groupIds: ["g-7b", "g-7a"], note: " Kopplung " });
    let d = await distribution(h.db, year, today);
    const a = d.assignments.find((x) => x.id === id)!;
    expect(a).toMatchObject({ hours: 4, planned: 0, doubleLessons: 1, note: "Kopplung" });
    expect(a.groups.map((g) => g.id).sort()).toEqual(["g-7a", "g-7b"]);
    const g = (dist: typeof d, gid: string) => dist.groups.find((x) => x.id === gid)!;
    expect(g(d, "g-7b").assigned).toBe(g(before, "g-7b").assigned + 4);
    expect(g(d, "g-7a").assigned).toBe(g(before, "g-7a").assigned + 4);
    const jana = (dist: typeof d) => dist.teachers.find((t) => t.id === "u-jana.brandt")!;
    expect(jana(d).assigned).toBe(jana(before).assigned + 4);

    // Teamteaching und eine verplante Stunde
    await updateAssignment(h.db, "u-admin", id, { ...base(), teacherIds: ["u-jana.brandt", "u-petra.lindner"], hours: 2, doubleLessons: 0 });
    await h.db.insert(timetableLessons).values({ groupId: "g-7b", weekday: 4, periodNr: 8, subjectId: "F", teacherId: "u-jana.brandt", validFrom: year.startsOn, validUntil: year.endsOn });
    d = await distribution(h.db, year, today);
    expect(d.assignments.find((x) => x.id === id)).toMatchObject({ hours: 2, planned: 1, groups: [{ id: "g-7b" }] });
    const petra = (dist: typeof d) => dist.teachers.find((t) => t.id === "u-petra.lindner")!;
    expect(petra(d).assigned).toBe(petra(before).assigned + 2);
    expect(g(d, "g-7b").planned).toBe(g(before, "g-7b").planned + 1);

    // Fach mit Lehrauftrag ist nicht löschbar
    await h.db.delete(timetableLessons).where(eq(timetableLessons.periodNr, 8));
    expect(Object.values(await fieldErrors(deleteSubject(h.db, "u-admin", "F")))[0]).toMatch(/Unterrichtsverteilung/);

    await deleteAssignment(h.db, "u-admin", id);
    expect((await listAssignments(h.db, year.id)).some((x) => x.id === id)).toBe(false);
    const log = await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.actorId, "u-admin"));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["stundenplan.assignment.create", "stundenplan.assignment.update", "stundenplan.assignment.delete"]));
  });

  it("Schuljahr ohne Aufträge, Übernahme aus dem Plan nur für Stunden ohne Auftrag", async () => {
    await h.db.insert(schoolYears).values({ id: "sj-test", name: "Test", startsOn: "2026-08-01", endsOn: "2027-07-31", isCurrent: false });
    const empty = { id: "sj-test", startsOn: "2026-08-01", endsOn: "2027-07-31" };
    expect((await distribution(h.db, empty, today)).assignments).toEqual([]);
    const n = await assignmentsFromTimetable(h.db, "u-admin", empty, today);
    expect(n).toBe((await listAssignments(h.db, year.id)).length);
  });
});
