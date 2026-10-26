import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, schoolYears, timetableAssignments, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteSubject } from "@/modules/verwaltung/stammdaten";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  assignmentsFromTimetable,
  bandStatus,
  createAssignment,
  createBand,
  deleteAssignment,
  deleteBand,
  distribution,
  listAssignments,
  matchLessons,
  planningYear,
  referenceDate,
  setBandMember,
  teacherAssigned,
  teacherPlanned,
  updateAssignment,
  updateBand,
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

  it("SP2-01: Lehrkraft zählt ein Band einmal, gekoppelte Gruppen im selben Slot einmal", () => {
    const t = [{ id: "t1", code: "EIN", name: "E" }];
    const list = [
      { hours: 2, bandId: "b", teachers: t },
      { hours: 2, bandId: "b", teachers: t },
      { hours: 3, bandId: null, teachers: t },
      { hours: 5, bandId: null, teachers: [] },
    ];
    expect(teacherAssigned(list, "t1")).toBe(5);
    const at = (id: string, groupId: string, weekday: number, periodNr: number, week = "all", weight = 1): PlanLesson => ({ ...lesson(id, groupId, "REL", "t1", weight), weekday, periodNr, week });
    expect(teacherPlanned([at("1", "7a", 0, 1), at("2", "7b", 0, 1), at("3", "7a", 0, 2), at("4", "7a", 1, 1, "A", 0.5), at("5", "7a", 1, 1, "B", 0.5)], "t1")).toBe(3);
  });

  it("SP2-01: Band – verplant = schwächstes Mitglied, gemeinsam = Slots aller Mitglieder, einheitlich = frühere Kopplung", () => {
    const lessons = [
      { ...lesson("1", "7a", "REL", "t1"), weekday: 0, periodNr: 1, week: "all" },
      { ...lesson("2", "7b", "PP", "t2"), weekday: 0, periodNr: 1, week: "all" },
      { ...lesson("3", "7a", "REL", "t1"), weekday: 1, periodNr: 3, week: "all" },
      { ...lesson("4", "7b", "PP", "t2"), weekday: 2, periodNr: 3, week: "all" },
    ];
    const assignmentOf = new Map([
      ["1", "a"],
      ["2", "b"],
      ["3", "a"],
      ["4", "b"],
    ]);
    const a = (id: string, subjectId: string, teacher: string, planned: number) => ({ id, subjectId, roomId: null, teachers: [{ id: teacher, code: null, name: teacher }], planned });
    const [mixed, empty] = bandStatus(
      [
        { id: "x", name: "Reli/PP 7", hours: 2, doubleLessons: 0, memberIds: ["a", "b"] },
        { id: "y", name: "leer", hours: 1, doubleLessons: 0, memberIds: [] },
      ],
      [a("a", "REL", "t1", 2), a("b", "PP", "t2", 2)],
      lessons,
      assignmentOf,
    );
    expect(mixed).toMatchObject({ planned: 2, together: 1, uniform: false });
    expect(empty).toMatchObject({ planned: 0, together: 0, uniform: true });
    const [same] = bandStatus([{ id: "z", name: "REL 7", hours: 2, doubleLessons: 0, memberIds: ["a", "c"] }], [a("a", "REL", "t1", 2), a("c", "REL", "t1", 0)], lessons, assignmentOf);
    expect(same).toMatchObject({ planned: 0, together: 0, uniform: true });
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
    groupId: "g-7b",
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

  it("A12: Gültigkeit mit unmöglichem Kalenderdatum ist ein Feldfehler, kein Datenbankfehler", async () => {
    expect((await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), validFrom: "2027-02-30" }))).validFrom).toBe("Datum angeben");
    expect((await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), validUntil: "2026-11-31" }))).validUntil).toBe("Datum angeben");
  });

  it("A15: gleiche Sortierschlüssel → Reihenfolge nach id bytegenau (unabhängig von der Collation der Datenbank)", async () => {
    const createdAt = new Date("2026-08-01T00:00:00Z");
    const ids = ["r1a-a", "r1a-B", "r1a-_", "r1a-Z"];
    await h.db.insert(timetableAssignments).values(ids.map((id) => ({ id, schoolYearId: year.id, subjectId: "F", hours: 1, createdAt })));
    const order = (await listAssignments(h.db, year.id)).map((a) => a.id).filter((id) => ids.includes(id));
    expect(order).toEqual([...ids].sort());
    await h.db.delete(timetableAssignments).where(inArray(timetableAssignments.id, ids));
  });

  it("prüft Eingaben", async () => {
    const used = (await listAssignments(h.db, year.id)).find((a) => a.groups.some((g) => g.id === "g-7b") && a.subjectId === "D")!;
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), groupId: "" }))).toHaveProperty("groupId");
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), hours: 0 }))).toHaveProperty("hours");
    expect((await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), hours: 3, doubleLessons: 2 }))).doubleLessons).toMatch(/höchstens 1/);
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), teacherIds: ["u-lea.schaefer"] }))).toHaveProperty("teacherIds");
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), groupId: "nope" }))).toHaveProperty("groupId");
    // SP2-01: höchstens zwei Lehrkräfte; unbekanntes Band
    expect((await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), teacherIds: ["u-jana.brandt", "u-petra.lindner", "u-frank.schulte"] }))).teacherIds).toMatch(/höchstens zwei/);
    expect(await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), bandId: "nope" }))).toHaveProperty("bandId");
    // gleiches Fach, gleiche Gruppe, gleiche Lehrkraft → doppelt
    const dup = await fieldErrors(createAssignment(h.db, "u-admin", { ...base(), subjectId: "D", teacherIds: used.teachers.map((t) => t.id) }));
    expect(dup.subjectId).toMatch(/hat schon einen Lehrauftrag Deutsch/);
  });

  it("legt an, ändert und löscht – Soll/verplant je Klasse und Lehrkraft", async () => {
    const before = await distribution(h.db, year, today);
    const id = await createAssignment(h.db, "u-admin", { ...base(), note: " Französisch neu " });
    let d = await distribution(h.db, year, today);
    const a = d.assignments.find((x) => x.id === id)!;
    expect(a).toMatchObject({ hours: 4, planned: 0, doubleLessons: 1, note: "Französisch neu", bandId: null });
    expect(a.groups.map((g) => g.id)).toEqual(["g-7b"]);
    const g = (dist: typeof d, gid: string) => dist.groups.find((x) => x.id === gid)!;
    expect(g(d, "g-7b").assigned).toBe(g(before, "g-7b").assigned + 4);
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

  it("SP2-01 Bänder: Demo-Schiene, anlegen, Mitglieder übernehmen die Stunden, Soll/verplant, Lehrkraft zählt einmal, löschen", async () => {
    const before = await distribution(h.db, year, today);
    // Demo: drei Q1-Grundkurse als Schiene – verschiedene Fächer, der Solver setzt sie bis SP2-02 einzeln
    const demo = before.bands.find((b) => b.id === "band-q1-gk-a")!;
    expect(demo).toMatchObject({ name: "Q1 GK-Schiene A", hours: 3, planned: 3, uniform: false });
    expect(demo.memberIds).toHaveLength(3);

    expect((await fieldErrors(createBand(h.db, "u-admin", { schoolYearId: year.id, name: "  ", hours: 2, doubleLessons: 0 }))).name).toBeTruthy();
    expect((await fieldErrors(createBand(h.db, "u-admin", { schoolYearId: year.id, name: "X", hours: 3, doubleLessons: 2 }))).doubleLessons).toMatch(/höchstens 1/);
    expect((await fieldErrors(createBand(h.db, "u-admin", { schoolYearId: year.id, name: "Q1 GK-Schiene A", hours: 3, doubleLessons: 0 }))).name).toMatch(/gibt es schon/);
    const bandId = await createBand(h.db, "u-admin", { schoolYearId: year.id, name: " Französisch 7 ", hours: 2, doubleLessons: 0 });

    // Mitglieder: Stunden kommen vom Band (Eingabe 4 → 2)
    const a7a = await createAssignment(h.db, "u-admin", { ...base(), groupId: "g-7a", bandId });
    const a7b = await createAssignment(h.db, "u-admin", { ...base(), bandId });
    let d = await distribution(h.db, year, today);
    const band = () => d.bands.find((b) => b.id === bandId)!;
    expect(band()).toMatchObject({ name: "Französisch 7", hours: 2, planned: 0, together: 0, uniform: true });
    expect(band().memberIds.sort()).toEqual([a7a, a7b].sort());
    expect(d.assignments.find((a) => a.id === a7a)).toMatchObject({ hours: 2, doubleLessons: 0, bandId });
    const jana = (dist: typeof d) => dist.teachers.find((t) => t.id === "u-jana.brandt")!;
    const grp = (dist: typeof d, gid: string) => dist.groups.find((x) => x.id === gid)!;
    expect(jana(d).assigned).toBe(jana(before).assigned + 2);
    expect(grp(d, "g-7a").assigned).toBe(grp(before, "g-7a").assigned + 2);
    expect(grp(d, "g-7b").assigned).toBe(grp(before, "g-7b").assigned + 2);

    // eine Stunde gemeinsam (beide Klassen, eine Lehrkraft), eine nur in der 7a
    const lesson = (groupId: string, periodNr: number) => ({ groupId, weekday: 4, periodNr, subjectId: "F", teacherId: "u-jana.brandt", validFrom: year.startsOn, validUntil: year.endsOn });
    const inserted = await h.db
      .insert(timetableLessons)
      .values([lesson("g-7a", 8), lesson("g-7b", 8), lesson("g-7a", 7)])
      .returning({ id: timetableLessons.id });
    d = await distribution(h.db, year, today);
    expect(band()).toMatchObject({ planned: 1, together: 1 });
    expect(d.assignments.find((a) => a.id === a7a)!.planned).toBe(2);

    // Stunden des Bands gehen an alle Mitglieder; Herausnehmen lässt die Stunden stehen
    await updateBand(h.db, "u-admin", bandId, { schoolYearId: year.id, name: "Französisch 7", hours: 3, doubleLessons: 1 });
    expect((await listAssignments(h.db, year.id)).filter((a) => a.bandId === bandId).map((a) => [a.hours, a.doubleLessons])).toEqual([
      [3, 1],
      [3, 1],
    ]);
    await setBandMember(h.db, "u-admin", a7b, null);
    d = await distribution(h.db, year, today);
    expect(band().memberIds).toEqual([a7a]);
    expect(d.assignments.find((a) => a.id === a7b)).toMatchObject({ bandId: null, hours: 3 });
    // Aufnehmen über die Band-Seite übernimmt wieder die Stunden
    await updateAssignment(h.db, "u-admin", a7b, { ...base(), hours: 1, doubleLessons: 0, bandId: null });
    await setBandMember(h.db, "u-admin", a7b, bandId);
    expect((await listAssignments(h.db, year.id)).find((a) => a.id === a7b)).toMatchObject({ bandId, hours: 3, doubleLessons: 1 });
    // ohne `bandId` im Input bleibt das Band
    await updateAssignment(h.db, "u-admin", a7b, { ...base(), hours: 1, doubleLessons: 0 });
    expect((await listAssignments(h.db, year.id)).find((a) => a.id === a7b)).toMatchObject({ bandId, hours: 3 });

    // Band löschen: Lehraufträge bleiben eigenständig
    await deleteBand(h.db, "u-admin", bandId);
    d = await distribution(h.db, year, today);
    expect(d.bands.some((b) => b.id === bandId)).toBe(false);
    expect(d.assignments.find((a) => a.id === a7a)).toMatchObject({ bandId: null, hours: 3 });
    const log = await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.actorId, "u-admin"));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["stundenplan.band.create", "stundenplan.band.update", "stundenplan.band.member", "stundenplan.band.delete"]));

    // aufräumen (der nächste Test vergleicht mit der Demo-Verteilung)
    await h.db.delete(timetableLessons).where(inArray(timetableLessons.id, inserted.map((l) => l.id)));
    await deleteAssignment(h.db, "u-admin", a7a);
    await deleteAssignment(h.db, "u-admin", a7b);
  });

  it("Schuljahr ohne Aufträge, Übernahme aus dem Plan nur für Stunden ohne Auftrag", async () => {
    await h.db.insert(schoolYears).values({ id: "sj-test", name: "Test", startsOn: "2026-08-01", endsOn: "2027-07-31", isCurrent: false });
    const empty = { id: "sj-test", startsOn: "2026-08-01", endsOn: "2027-07-31" };
    expect((await distribution(h.db, empty, today)).assignments).toEqual([]);
    const n = await assignmentsFromTimetable(h.db, "u-admin", empty, today);
    expect(n).toBe((await listAssignments(h.db, year.id)).length);
  });
});
