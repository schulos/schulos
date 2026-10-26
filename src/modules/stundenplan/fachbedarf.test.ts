import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { timetableStaffChanges, users } from "@/core/db/schema";
import { planDeletion, runDeletion } from "@/core/privacy/loeschlauf";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  addStaffChange,
  adviceFor,
  computeCoverage,
  computeForecast,
  deleteStaffChange,
  gradeForecast,
  loadFachbedarf,
  needTone,
  nextYearName,
  saveForecastGrades,
  type ForecastInput,
} from "./fachbedarf";
import { setTeacherSubjects } from "./lehrfaecher";
import { planningYear } from "./verteilung";

const t = (id: string) => ({ id, code: id.toUpperCase(), name: `Name ${id}` });
const a = (id: string, groupId: string, subjectId: string, hours: number, teachers: string[], bandId: string | null = null) => ({
  id,
  subjectId,
  hours,
  bandId,
  groups: [{ id: groupId, name: groupId }],
  teachers: teachers.map(t),
});

/** Kleine Schule: Jahrgänge 5–7, Kurse; T1 Mathe, T2 Physik/Chemie, T3 ohne Lehrfach */
function school(): ForecastInput {
  return {
    subjects: [
      { id: "M", name: "Mathematik", color: "#111111" },
      { id: "PH", name: "Physik", color: "#222222" },
      { id: "CH", name: "Chemie", color: "#333333" },
      { id: "KU", name: "Kunst", color: "#444444" },
    ],
    assignments: [
      a("a1", "k7a", "M", 4, ["t1"]),
      a("a2", "k7b", "M", 4, ["t1"]),
      a("a3", "k7a", "PH", 2, ["t2"]),
      // Teamteaching zählt je Lehrkraft
      a("a4", "kurs1", "CH", 3, ["t2", "t3"]),
      // Band: dieselbe Lehrkraft in zwei Kursen zur selben Zeit zählt einmal
      a("a5", "kurs1", "M", 2, ["t1"], "b1"),
      a("a6", "kurs2", "M", 2, ["t1"], "b1"),
    ],
    groups: [
      { id: "k5a", kind: "klasse", gradeLevel: 5 },
      { id: "k7a", kind: "klasse", gradeLevel: 7 },
      { id: "k7b", kind: "klasse", gradeLevel: 7 },
      { id: "kurs1", kind: "kurs", gradeLevel: null },
      { id: "kurs2", kind: "kurs", gradeLevel: null },
    ],
    curriculum: new Map([
      [5, new Map([["M", 4]])],
      [6, new Map([["M", 4]])],
      [7, new Map([["M", 4], ["PH", 2]])],
    ]),
    teachers: [
      { ...t("t1"), target: 10 },
      { ...t("t2"), target: 10 },
      { ...t("t3"), target: 5 },
    ],
    teacherSubjects: new Map([
      ["t1", ["M"]],
      ["t2", ["PH", "CH"]],
    ]),
    changes: [
      { id: "c1", kind: "abgang", teacherId: "t1", subjectIds: [], effectiveOn: "2027-08-01", hours: 5 },
      { id: "c2", kind: "zugang", teacherId: null, subjectIds: ["PH", "CH"], effectiveOn: "2027-08-01", hours: 4 },
      // nach dem nächsten Schuljahr – zählt nicht
      { id: "c3", kind: "abgang", teacherId: "t2", subjectIds: [], effectiveOn: "2029-02-01", hours: 10 },
    ],
    customGrades: new Map(),
    untilYmd: "2028-07-31",
  };
}

describe("Fachbedarf – Berechnung (rein)", () => {
  it("Ampel und Empfehlungen", () => {
    expect(needTone(0, 0, 0)).toBe("success");
    expect(needTone(10, 10, 2)).toBe("success");
    expect(needTone(10, 8, 2)).toBe("warn");
    expect(needTone(40, 35, 2)).toBe("danger");
    expect(needTone(4, 10, 0)).toBe("danger");
    expect(adviceFor("Physik", 10, 4, 2)).toEqual(["Physik: −6 Std. – Einstellung, Abordnung oder Mehrarbeit prüfen"]);
    expect(adviceFor("Physik", 10, 10, 1)).toEqual(["Physik: nur eine Lehrkraft deckt das Fach – bei Ausfall keine fachgleiche Vertretung"]);
    expect(adviceFor("Physik", 3, 0, 0)[0]).toMatch(/keine Lehrkraft mit diesem Lehrfach/);
    // Überhang ist keine Empfehlung: freies Soll verteilt sich auf mehrere Lehrfächer (zählt je Fach nur anteilig)
    expect(adviceFor("Kunst", 4, 12, 2)).toEqual([]);
    expect(adviceFor("Kunst", 0, 12, 2)).toEqual([]);
  });

  it("Bedarf: Teamteaching je Lehrkraft, Band einer Lehrkraft einmal, fehlende Stundentafel; Versorgung anteilig nach Lehrfächern", () => {
    const { rows } = computeCoverage(school(), true);
    const by = new Map(rows.map((r) => [r.subjectId, r]));
    // Mathe: 4 + 4 + 2 (Band einmal) + 4 fehlen in 5a laut Stundentafel
    expect(by.get("M")).toMatchObject({ assigned: 10, missing: 4, demand: 14, supply: 10, balance: -4, tone: "danger", teacherCount: 1 });
    expect(by.get("M")!.advice).toEqual(["Mathematik: −4 Std. – Einstellung, Abordnung oder Mehrarbeit prüfen", "Mathematik: nur eine Lehrkraft deckt das Fach – bei Ausfall keine fachgleiche Vertretung"]);
    // Physik: 2 + 2 fehlen in 7b; T2 hat 2 PH + 3 CH, Rest 5 halb/halb → PH 4,5
    expect(by.get("PH")).toMatchObject({ assigned: 2, missing: 2, demand: 4, supply: 4.5, balance: 0.5, tone: "success" });
    // Chemie: Teamteaching 2 × 3; nur T2 hat das Lehrfach (T3 ohne Lehrfächer zählt nicht)
    expect(by.get("CH")).toMatchObject({ assigned: 6, demand: 6, supply: 5.5, tone: "warn", teacherCount: 1 });
    expect(by.get("CH")!.teachers).toEqual([{ id: "t2", code: "T2", name: "Name t2", hours: 5.5 }]);
    // Kunst: weder Bedarf noch Lehrkraft – keine Zeile
    expect(by.has("KU")).toBe(false);
  });

  it("Überhang in den Lehrfächern wird aufs Soll gekürzt", () => {
    const input = school();
    input.teachers[0] = { ...t("t1"), target: 5 };
    const m = computeCoverage(input, false).rows.find((r) => r.subjectId === "M")!;
    expect(m.supply).toBe(5);
  });

  it("aggregiert (ohne Details) gibt es keine Personenfelder", () => {
    const { rows } = computeCoverage(school(), false);
    expect(rows.every((r) => r.teachers === undefined)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/Name t|"t1"|"t2"/);
  });

  it("Klassen rücken auf; eigene Klassenzahl ersetzt den Vorschlag", () => {
    expect(gradeForecast(school()).map((g) => [g.grade, g.current, g.suggested, g.next, g.source])).toEqual([
      [5, 1, 1, 1, "stundentafel"],
      [6, 0, 1, 1, "stundentafel"],
      [7, 2, 0, 0, "stundentafel"],
    ]);
    const custom = gradeForecast({ ...school(), customGrades: new Map([[6, 2]]) });
    expect(custom.find((g) => g.grade === 6)).toMatchObject({ custom: 2, next: 2, suggested: 1 });
  });

  it("Prognose: Abgänge kürzen die Versorgung, Zugänge verteilen sich auf ihre Fächer, spätere zählen nicht", () => {
    const input = school();
    const cov = computeCoverage(input, false);
    const { rows } = computeForecast(input, cov);
    const by = new Map(rows.map((r) => [r.subjectId, r]));
    // Mathe: 5. und 6. Jahrgang je 1 Klasse × 4 + Kurs-Band 2; T1 verliert 5 von 10
    expect(by.get("M")).toMatchObject({ demand: 10, supply: 5, leaving: 5, joining: 0, tone: "danger", teacherCount: 1 });
    // Physik: kein 7. Jahrgang mehr; Zugang + 2
    expect(by.get("PH")).toMatchObject({ demand: 0, supply: 6.5, joining: 2, teacherCount: 2 });
    expect(by.get("CH")).toMatchObject({ demand: 6, supply: 7.5, tone: "success", teacherCount: 2 });
    const more = computeForecast({ ...input, customGrades: new Map([[6, 2]]) }, cov);
    expect(more.rows.find((r) => r.subjectId === "M")!.demand).toBe(14);
    expect(JSON.stringify(rows)).not.toMatch(/Name t|"t1"/);
  });

  it("Name des Folgejahres", () => {
    expect(nextYearName("2026/27")).toBe("2027/28");
    expect(nextYearName("2099/00")).toBe("2100/01");
    expect(nextYearName("2026/2027")).toBe("2027/2028");
    expect(nextYearName("Schuljahr X")).toBe("nächstes Schuljahr");
  });
});

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Fachbedarf (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Details nur mit `manage`; aggregiert ohne Namen, ohne Abgänge, ohne Lehrkräfte-Liste", async () => {
    const id = await addStaffChange(h.db, "u-admin", { kind: "abgang", teacherId: "u-tobias.kleine", subjectIds: [], effectiveOn: "2027-08-01", hours: 10 });
    const full = (await loadFachbedarf(h.db, today, { details: true }))!;
    expect(full.current.length).toBeGreaterThan(5);
    expect(full.current.some((r) => r.teachers?.some((x) => x.id === "u-tobias.kleine"))).toBe(true);
    expect(full.changes).toEqual([expect.objectContaining({ id, kind: "abgang", teacherId: "u-tobias.kleine", teacherCode: "KLE" })]);
    const agg = (await loadFachbedarf(h.db, today, { details: false }))!;
    expect(agg.changes).toBeUndefined();
    expect(agg.teachersWithoutSubjects).toBeUndefined();
    expect(agg.current.every((r) => r.teachers === undefined)).toBe(true);
    const json = JSON.stringify(agg);
    const names = await h.db.select({ id: users.id, name: users.name, code: users.shortCode }).from(users).where(eq(users.role, "lehrkraft"));
    for (const n of names) {
      expect(json).not.toContain(n.id);
      expect(json).not.toContain(n.name);
    }
    // Abgang wirkt in der Prognose nur als Summe je Fach
    expect(agg.forecast.find((r) => r.subjectId === "PH")!.leaving).toBeGreaterThan(0);
    await deleteStaffChange(h.db, "u-admin", id);
    expect((await loadFachbedarf(h.db, today, { details: true }))!.changes).toEqual([]);
  });

  it("Lehrkraft ohne Lehrfächer zählt nicht und wird genannt", async () => {
    await setTeacherSubjects(h.db, "u-admin", "u-murat.yilmaz", []);
    const f = (await loadFachbedarf(h.db, today, { details: true }))!;
    expect(f.unmaintained).toBe(1);
    expect(f.teachersWithoutSubjects).toEqual([expect.objectContaining({ id: "u-murat.yilmaz" })]);
    expect(f.current.some((r) => r.teachers?.some((x) => x.id === "u-murat.yilmaz"))).toBe(false);
    await setTeacherSubjects(h.db, "u-admin", "u-murat.yilmaz", ["M", "IF"]);
  });

  it("Abgang/Zugang prüfen: ohne Begründung, Stunden und Datum Pflicht", async () => {
    expect(await fieldErrors(addStaffChange(h.db, "u-admin", { kind: "abgang", teacherId: null, subjectIds: [], effectiveOn: "2027-08-01", hours: 5 }))).toHaveProperty("teacherId");
    expect(await fieldErrors(addStaffChange(h.db, "u-admin", { kind: "abgang", teacherId: "u-lea.schaefer", subjectIds: [], effectiveOn: "2027-08-01", hours: 5 }))).toHaveProperty("teacherId");
    expect(await fieldErrors(addStaffChange(h.db, "u-admin", { kind: "zugang", teacherId: null, subjectIds: [], effectiveOn: "2027-08-01", hours: 5 }))).toHaveProperty("subjectIds");
    expect(await fieldErrors(addStaffChange(h.db, "u-admin", { kind: "zugang", teacherId: null, subjectIds: ["XX"], effectiveOn: "2027-08-01", hours: 5 }))).toHaveProperty("subjectIds");
    expect(await fieldErrors(addStaffChange(h.db, "u-admin", { kind: "zugang", teacherId: null, subjectIds: ["PH"], effectiveOn: "2027-02-30", hours: 5 }))).toHaveProperty("effectiveOn");
    expect(await fieldErrors(addStaffChange(h.db, "u-admin", { kind: "zugang", teacherId: null, subjectIds: ["PH"], effectiveOn: "2027-08-01", hours: 0.3 }))).toHaveProperty("hours");
    expect(await fieldErrors(addStaffChange(h.db, "u-admin", { kind: "ruhestand", teacherId: null, subjectIds: ["PH"], effectiveOn: "2027-08-01", hours: 5 }))).toHaveProperty("kind");
    // Zugang ohne Person: eine Lehrkraft im Eingabefeld wird nicht gespeichert
    const id = await addStaffChange(h.db, "u-admin", { kind: "zugang", teacherId: "u-tobias.kleine", subjectIds: ["PH", "PH", "CH"], effectiveOn: "2027-08-01", hours: 12.5 });
    const [row] = await h.db.select().from(timetableStaffChanges).where(eq(timetableStaffChanges.id, id));
    expect(row).toMatchObject({ kind: "zugang", teacherId: null, subjectIds: ["PH", "CH"], hours: 12.5 });
    const f = (await loadFachbedarf(h.db, today, { details: false }))!;
    expect(f.forecast.find((r) => r.subjectId === "PH")!.joining).toBe(6.3);
    await deleteStaffChange(h.db, "u-admin", id);
  });

  it("Klassenzahlen je Jahrgang speichern und zurücksetzen", async () => {
    const year = (await planningYear(h.db))!;
    const before = (await loadFachbedarf(h.db, today, { details: false }))!;
    const g5 = before.grades.find((g) => g.grade === 5)!;
    await saveForecastGrades(h.db, "u-admin", year.id, [{ grade: 5, classes: g5.suggested + 2 }]);
    const after = (await loadFachbedarf(h.db, today, { details: false }))!;
    expect(after.grades.find((g) => g.grade === 5)).toMatchObject({ custom: g5.suggested + 2, next: g5.suggested + 2 });
    const d = (r: typeof after) => r.forecast.find((x) => x.subjectId === "M")!.demand;
    expect(d(after)).toBeGreaterThan(d(before));
    await saveForecastGrades(h.db, "u-admin", year.id, [{ grade: 5, classes: null }]);
    expect((await loadFachbedarf(h.db, today, { details: false }))!.grades.find((g) => g.grade === 5)!.custom).toBeNull();
    expect(await fieldErrors(saveForecastGrades(h.db, "u-admin", year.id, [{ grade: 5, classes: 31 }]))).toHaveProperty("g5");
  });

  it("Löschlauf: Abgänge ein Jahr nach dem Datum, mit dem Konto sofort", async () => {
    const old = await addStaffChange(h.db, "u-admin", { kind: "abgang", teacherId: "u-tobias.kleine", subjectIds: [], effectiveOn: "2025-07-31", hours: 5 });
    const fresh = await addStaffChange(h.db, "u-admin", { kind: "abgang", teacherId: "u-tobias.kleine", subjectIds: [], effectiveOn: "2026-09-01", hours: 5 });
    const plan = await planDeletion(h.db, today);
    expect(plan.find((p) => p.table === "timetable_staff_changes")).toMatchObject({ status: "due", count: 1, classId: "LK-ENDE-1J" });
    await runDeletion(h.db, "u-admin", today);
    const left = (await h.db.select({ id: timetableStaffChanges.id }).from(timetableStaffChanges)).map((r) => r.id);
    expect(left).toContain(fresh);
    expect(left).not.toContain(old);
    await deleteStaffChange(h.db, "u-admin", fresh);
  });
});
