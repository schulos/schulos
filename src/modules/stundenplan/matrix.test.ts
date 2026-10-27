import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, schoolYears, schoolYearTransitions, timetableAssignments, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { addDays } from "@/core/time";
import { addNextSchoolYear } from "@/modules/verwaltung/school-years";
import { promote, startTransition } from "@/modules/verwaltung/schuljahreswechsel";
import {
  buildMatrix,
  cellKey,
  classMapFor,
  gapAround,
  liveBalance,
  loadMatrix,
  matrixSuggestions,
  oneToOne,
  parseEdits,
  reconstructClassMap,
  resolveTeacher,
  saveMatrixEdits,
  suggestFrom,
  type MatrixSource,
} from "./matrix";
import { createBand, distribution, listAssignments, planningYear, setBandMember, updateAssignment } from "./verteilung";
import { ValidationError } from "@/modules/verwaltung/users";

const t = (id: string, code: string) => ({ id, code, name: `Name ${code}` });

describe("SP3-LA Matrix (rein)", () => {
  const src: MatrixSource = {
    classes: [
      { id: "7a", name: "Klasse 7a", gradeLevel: 7 },
      { id: "7b", name: "Klasse 7b", gradeLevel: 7 },
    ],
    subjects: [
      { id: "D", name: "Deutsch", color: "#111" },
      { id: "M", name: "Mathematik", color: "#222" },
      { id: "REL", name: "Religion", color: "#333" },
      { id: "IF", name: "Informatik", color: "#444" },
    ],
    curriculum: new Map([[7, new Map([["D", 4], ["M", 4], ["REL", 0]])]]),
    assignments: [
      { id: "a1", subjectId: "D", hours: 4, bandId: null, validFrom: null, validUntil: null, groups: [{ id: "7a" }], teachers: [t("t1", "BRA")] },
      { id: "a2", subjectId: "M", hours: 4, bandId: null, validFrom: null, validUntil: null, groups: [{ id: "7a" }], teachers: [t("t2", "KLE"), t("t3", "YIL")] },
      { id: "a3", subjectId: "IF", hours: 2, bandId: "b1", validFrom: null, validUntil: null, groups: [{ id: "7b" }], teachers: [t("t3", "YIL")] },
      { id: "x", subjectId: "D", hours: 4, bandId: null, validFrom: null, validUntil: null, groups: [{ id: "8a" }], teachers: [t("t1", "BRA")] },
    ],
  };

  it("buildMatrix: Spalten aus Stundentafel und Lehraufträgen, Soll je Zelle, Band/Teamteaching nicht bearbeitbar", () => {
    const m = buildMatrix(src);
    expect(m.columns.map((c) => c.subjectId)).toEqual(["D", "M", "IF"]); // REL mit 0 Std. nicht, IF aus dem Lehrauftrag
    const cell = (g: string, s: string) => m.rows.find((r) => r.groupId === g)!.cells.find((c) => c.subjectId === s)!;
    expect(cell("7a", "D")).toMatchObject({ soll: 4, editable: true, assignments: [{ id: "a1", teacherCodes: ["BRA"] }] });
    expect(cell("7a", "M").editable).toBe(false); // Teamteaching
    expect(cell("7b", "IF")).toMatchObject({ soll: null, editable: false }); // Band
    expect(cell("7b", "D")).toMatchObject({ soll: 4, editable: true, assignments: [] });
    expect(m.rows[0]!.curriculum).toBe(8);
  });

  it("liveBalance: Stunden wandern von der bisherigen zur neuen Lehrkraft; unveränderte Zellen zählen nicht", () => {
    const accounts = [
      { id: "t1", code: "BRA", name: "B", target: 20, assigned: 18 },
      { id: "t2", code: "KLE", name: "K", target: 25.5, assigned: 26 },
      { id: "t3", code: "YIL", name: "Y", target: 10, assigned: 10 },
    ];
    const res = liveBalance(accounts, [
      { before: { teacherId: "t1", hours: 4 }, after: { teacherId: "t2", hours: 3 } },
      { before: { teacherId: null, hours: 0 }, after: { teacherId: "t1", hours: 2 } },
      { before: { teacherId: "t3", hours: 2 }, after: { teacherId: "t3", hours: 2 } },
    ]);
    expect(res.map((b) => [b.code, b.live, b.delta, b.rest])).toEqual([
      ["BRA", 16, -2, 4],
      ["KLE", 29, 3, -3.5],
    ]);
  });

  it("resolveTeacher: Kürzel ohne Groß-/Kleinschreibung, Vorschlagstext, Name; leer = offen; unbekannt = null", () => {
    const list = [t("t1", "BRA"), t("t2", "KLE")];
    expect(resolveTeacher("bra", list)?.teacher?.id).toBe("t1");
    expect(resolveTeacher("KLE – Name KLE · Rest 2", list)?.teacher?.id).toBe("t2");
    expect(resolveTeacher("Name KLE", list)?.teacher?.id).toBe("t2");
    expect(resolveTeacher("  ", list)).toEqual({ teacher: null });
    expect(resolveTeacher("XYZ", list)).toBeNull();
  });

  it("gapAround: neuer Lehrauftrag füllt die Lücke zwischen Lehraufträgen anderer Zeiträume", () => {
    expect(gapAround("2027-03-01", [])).toEqual({ validFrom: null, validUntil: null });
    expect(gapAround("2027-03-01", [{ validFrom: null, validUntil: "2027-01-31" }])).toEqual({ validFrom: "2027-02-01", validUntil: null });
    expect(gapAround("2026-10-01", [{ validFrom: "2027-02-01", validUntil: null }])).toEqual({ validFrom: null, validUntil: "2027-01-31" });
  });

  it("suggestFrom: Lehrkraft folgt der Klasse – nur leere bearbeitbare Zellen, keine Bänder, nicht aktive ohne Lehrkraft", () => {
    const m = buildMatrix({ ...src, assignments: src.assignments.filter((a) => a.id === "a1") });
    const res = suggestFrom(
      [
        { groupId: "6a", subjectId: "D", hours: 5, teacherIds: ["t1"], bandId: null }, // → 7a D ist belegt
        { groupId: "6b", subjectId: "D", hours: 5, teacherIds: ["t1"], bandId: null }, // → 7b D, Soll 4
        { groupId: "6b", subjectId: "M", hours: 3, teacherIds: ["t9"], bandId: null }, // nicht aktiv
        { groupId: "6b", subjectId: "IF", hours: 1, teacherIds: ["t3"], bandId: "b" }, // Band
        { groupId: "kurs", subjectId: "M", hours: 3, teacherIds: ["t2"], bandId: null }, // nicht zugeordnet
      ],
      new Map([
        ["6a", "7a"],
        ["6b", "7b"],
      ]),
      m,
      { active: new Set(["t1", "t2", "t3"]), groupName: new Map([["6b", "Klasse 6b"]]), teacherCode: new Map([["t1", "BRA"], ["t9", "ALT"]]) },
    );
    expect(res).toEqual([
      { groupId: "7b", subjectId: "D", teacherId: "t1", hours: 4, from: "Klasse 6b: BRA" },
      { groupId: "7b", subjectId: "M", teacherId: null, hours: 4, from: "Klasse 6b: ALT (nicht mehr aktiv)" },
    ]);
  });

  it("Klassen-Zuordnung: Namensregel nur eindeutig, gespeicherte Zuordnung nur 1:1", () => {
    const map = reconstructClassMap(
      [
        { id: "o7a", name: "7a", gradeLevel: 7 },
        { id: "o7b", name: "7b", gradeLevel: 7 },
        { id: "o10a", name: "10a", gradeLevel: 10 },
        { id: "o10b", name: "10b", gradeLevel: 10 },
      ],
      [
        { id: "n8a", name: "8a" },
        { id: "nef", name: "EF" },
      ],
      (name, level) => (level === 10 ? "EF" : name.replace(String(level), String(level + 1))),
    );
    expect([...map]).toEqual([["o7a", "n8a"]]);
    expect([...oneToOne({ a: "x", b: "y", c: "y" })]).toEqual([["a", "x"]]);
  });

  it("parseEdits: nur gültige Formen, höchstens 400 auf einmal", () => {
    expect(parseEdits([{ groupId: "g", subjectId: "s", assignmentId: "", teacherId: "t", hours: 2 }])).toEqual([
      { groupId: "g", subjectId: "s", assignmentId: null, teacherId: "t", hours: 2, offSubjectOk: null },
    ]);
    expect(() => parseEdits("x")).toThrow(ValidationError);
    expect(() => parseEdits([{ groupId: "g" }])).toThrow(ValidationError);
    expect(() => parseEdits(Array.from({ length: 401 }, () => ({ groupId: "g", subjectId: "s", hours: 1 })))).toThrow(ValidationError);
  });
});

describe("SP3-LA Matrix (Demo-Schule)", () => {
  let h: DbHandle;
  let year: NonNullable<Awaited<ReturnType<typeof planningYear>>>;
  const today = "2026-10-27";

  beforeAll(async () => {
    h = await createSeededTestDb();
    year = (await planningYear(h.db))!;
  });
  afterAll(() => h.close());

  it("Matrix eines Jahrgangs: Zellen vorbefüllt mit Stundentafel-Soll und Lehrauftrag", async () => {
    const d = await distribution(h.db, year, today);
    const m = await loadMatrix(h.db, d, 7);
    expect(m.rows.map((r) => r.groupId)).toContain("g-7b");
    const cell = m.rows.find((r) => r.groupId === "g-7b")!.cells.find((c) => c.subjectId === "D")!;
    expect(cell).toMatchObject({ editable: true, assignments: [{ id: "la-g-7b-D", teacherCodes: ["BRA"] }] });
    expect(cell.soll).toBe(cell.assignments[0]!.hours);
  });

  it("Speichern: ändern, fachfremd nur mit Bestätigung, löschen, neu anlegen; Audit mit Anzahlen", async () => {
    const ref = today;
    const res1 = await saveMatrixEdits(h.db, "u-frank.schulte", year, ref, [
      { groupId: "g-7b", subjectId: "D", assignmentId: "la-g-7b-D", teacherId: "u-claudia.becker", hours: 5 },
      { groupId: "g-7b", subjectId: "E", assignmentId: "la-g-7b-E", teacherId: "u-tobias.kleine", hours: 4 },
    ]);
    expect(res1[0]).toEqual({ key: cellKey("g-7b", "D"), ok: true });
    expect(res1[1]).toMatchObject({ ok: false, needsConfirm: true, error: expect.stringMatching(/KLE unterrichtet Englisch laut Stammdaten nicht/) });
    const after = await listAssignments(h.db, year.id);
    const d7b = after.find((a) => a.id === "la-g-7b-D")!;
    expect(d7b).toMatchObject({ hours: 5, teachers: [{ id: "u-claudia.becker" }] });

    const res2 = await saveMatrixEdits(h.db, "u-frank.schulte", year, ref, [
      { groupId: "g-7b", subjectId: "E", assignmentId: "la-g-7b-E", teacherId: "u-tobias.kleine", hours: 4, offSubjectOk: "u-tobias.kleine" },
      { groupId: "g-7b", subjectId: "D", assignmentId: "la-g-7b-D", teacherId: null, hours: 0 },
    ]);
    expect(res2.every((r) => r.ok)).toBe(true);
    expect((await h.db.select().from(timetableAssignments).where(eq(timetableAssignments.id, "la-g-7b-D"))).length).toBe(0);
    // neu in der leeren Zelle
    const res3 = await saveMatrixEdits(h.db, "u-frank.schulte", year, ref, [{ groupId: "g-7b", subjectId: "D", assignmentId: null, teacherId: "u-jana.brandt", hours: 4 }]);
    expect(res3[0]!.ok).toBe(true);
    const created = (await listAssignments(h.db, year.id)).filter((a) => a.subjectId === "D" && a.groups[0]!.id === "g-7b");
    expect(created).toMatchObject([{ hours: 4, validFrom: null, validUntil: null, teachers: [{ id: "u-jana.brandt" }] }]);
    // zweites Anlegen in derselben Zelle → Hinweis statt Dublette
    const res4 = await saveMatrixEdits(h.db, "u-frank.schulte", year, ref, [{ groupId: "g-7b", subjectId: "D", assignmentId: null, teacherId: "u-claudia.becker", hours: 1 }]);
    expect(res4[0]).toMatchObject({ ok: false, error: expect.stringMatching(/inzwischen/) });

    const rows = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.assignment.matrix"));
    expect(rows.map((r) => r.meta)).toEqual([
      { created: 0, updated: 1, deleted: 0, failed: 1, source: "matrix" },
      { created: 0, updated: 1, deleted: 1, failed: 0, source: "matrix" },
      { created: 1, updated: 0, deleted: 0, failed: 0, source: "matrix" },
    ]);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.assignment.off_subject"))).length).toBeGreaterThan(0);
  });

  it("Speichern: Band, nicht aktive Lehrkraft und ungültige Stunden werden abgelehnt", async () => {
    const band = await createBand(h.db, "u-admin", { schoolYearId: year.id, name: "Test-Band M", hours: 4, doubleLessons: 0 });
    await setBandMember(h.db, "u-admin", "la-g-7a-M", band);
    await h.db.update(users).set({ status: "locked" }).where(eq(users.id, "u-julia.fischer"));
    const res = await saveMatrixEdits(h.db, "u-frank.schulte", year, today, [
      { groupId: "g-7a", subjectId: "M", assignmentId: "la-g-7a-M", teacherId: "u-tobias.kleine", hours: 4 },
      { groupId: "g-7a", subjectId: "D", assignmentId: "la-g-7a-D", teacherId: "u-julia.fischer", hours: 4 },
      { groupId: "g-7a", subjectId: "E", assignmentId: "la-g-7a-E", teacherId: null, hours: 13 },
    ]);
    expect(res.map((r) => r.ok)).toEqual([false, false, false]);
    expect(res[0]!.error).toMatch(/Band/);
    expect(res[1]!.error).toMatch(/nicht mehr aktiv/);
    expect(res[2]!.error).toMatch(/0 bis 12/);
    await h.db.update(users).set({ status: "active" }).where(eq(users.id, "u-julia.fischer"));
    await expect(saveMatrixEdits(h.db, "u-frank.schulte", year, "2030-01-01", [])).rejects.toThrow(ValidationError);
  });

  it("Übernahme aus dem 1. Halbjahr: Vorschlag für die leere Zelle, angelegt ab Beginn des 2. Halbjahrs", async () => {
    const term2 = year.term2StartsOn!;
    const [a] = await listAssignments(h.db, year.id).then((l) => l.filter((x) => x.id === "la-g-7a-E"));
    await updateAssignment(h.db, "u-admin", a!.id, {
      schoolYearId: year.id,
      groupId: "g-7a",
      subjectId: "E",
      hours: a!.hours,
      teacherIds: a!.teachers.map((x) => x.id),
      doubleLessons: a!.doubleLessons,
      roomId: a!.roomId,
      note: a!.note,
      validUntil: addDays(term2, -1),
    });
    const ref = "2027-03-01";
    const d = await distribution(h.db, year, ref);
    const m = await loadMatrix(h.db, d, 7);
    const { suggestions, label } = await matrixSuggestions(h.db, year, ref, m, "halbjahr");
    expect(label).toBe("aus dem 1. Halbjahr");
    const s = suggestions.find((x) => x.groupId === "g-7a" && x.subjectId === "E")!;
    expect(s).toMatchObject({ teacherId: a!.teachers[0]!.id, hours: a!.hours });
    // im 1. Halbjahr gibt es keine Halbjahres-Vorschläge
    expect((await matrixSuggestions(h.db, year, today, m, "halbjahr")).suggestions).toEqual([]);
    const res = await saveMatrixEdits(h.db, "u-frank.schulte", year, ref, [{ ...s, assignmentId: null }], "halbjahr");
    expect(res[0]!.ok).toBe(true);
    const both = (await listAssignments(h.db, year.id)).filter((x) => x.subjectId === "E" && x.groups[0]!.id === "g-7a");
    expect(both.map((x) => [x.validFrom, x.validUntil]).sort()).toEqual([
      [null, addDays(term2, -1)],
      [term2, null],
    ]);
  });

  it("Übernahme aus dem Vorjahr: Versetzung speichert class_map, Lehrkraft folgt der Klasse; ohne class_map über die Namensregel", async () => {
    const toId = await addNextSchoolYear(h.db, "u-admin", "2027-06-01");
    const tid = await startTransition(h.db, "u-admin", year.id, toId);
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    const [tr] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    expect(tr!.classMap).toBeTruthy();
    const new8b = tr!.classMap!["g-7b"]!;
    expect(tr!.classMap!["g-10a"]).toBe(tr!.classMap!["g-10b"]); // Parallelklassen laufen in der EF zusammen
    const mapped = await classMapFor(h.db, year.id, toId);
    expect(mapped.reconstructed).toBe(false);
    expect(mapped.map.get("g-7b")).toBe(new8b);
    expect(mapped.map.has("g-10a")).toBe(false); // 1:1 nur

    const [next] = await h.db.select().from(schoolYears).where(eq(schoolYears.id, toId));
    const d = await distribution(h.db, next!, next!.startsOn);
    const m = await loadMatrix(h.db, d, 8);
    const res = await matrixSuggestions(h.db, next!, d.refYmd, m, "vorjahr");
    expect(res.label).toBe(`aus dem Schuljahr ${year.name}`);
    const old7bE = (await listAssignments(h.db, year.id)).find((a) => a.id === "la-g-7b-E")!;
    const sE = res.suggestions.find((s) => s.groupId === new8b && s.subjectId === "E")!;
    expect(sE.teacherId).toBe(old7bE.teachers[0]!.id);
    expect(sE.from).toMatch(/^Klasse 7b: /);
    // Kurse (Oberstufe) und Bänder nicht: keine Vorschläge für Gruppen, die keine Klassen sind
    expect(res.suggestions.every((s) => m.rows.some((r) => r.groupId === s.groupId))).toBe(true);
    // speichern: Lehraufträge im neuen Schuljahr
    const saved = await saveMatrixEdits(h.db, "u-frank.schulte", next!, d.refYmd, res.suggestions.map((s) => ({ ...s, assignmentId: null, offSubjectOk: s.teacherId })), "vorjahr");
    expect(saved.filter((r) => r.ok).length).toBe(res.suggestions.length);
    expect((await listAssignments(h.db, toId)).length).toBe(res.suggestions.length);
    const [sum] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "stundenplan.assignment.matrix")));
    expect(sum).toBeTruthy();

    // Übergang vor SP3-LA (ohne class_map): Rekonstruktion über die Namen
    await h.db.update(schoolYearTransitions).set({ classMap: null }).where(eq(schoolYearTransitions.id, tid));
    const rec = await classMapFor(h.db, year.id, toId);
    expect(rec.reconstructed).toBe(true);
    expect(rec.map.get("g-7b")).toBe(new8b);
    expect(rec.map.has("g-10a")).toBe(false);
  }, 60_000);
});
