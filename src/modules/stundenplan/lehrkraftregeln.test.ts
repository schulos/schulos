// SP2-04: Tagesregeln je Lehrkraft (hart) und Fachverteilung über die Woche (weich) – reine Regeln, Solver, Vorprüfung, Setzhilfe,
// Diagnose; Pflege/Laden in der Demo-Schule inkl. Löschung mit dem Konto.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableTeacherDayRules, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteAccounts } from "@/core/privacy/konto";
import { DEFAULT_WEIGHTS, solve, validate, type SolverInput, type SolverUnit } from "./solver";
import { precheck } from "./solver-check";
import { placementCell, type GridLesson } from "./setzhilfe";
import { diagnose, type DiagnoseInput } from "./diagnose";
import { deputyAccounts, listTeacherRules, loadTeacherLimits, saveTeacherRule } from "./deputate";
import { teacherLimitReasons, teacherViolationsWith, teacherWeeklyCapacity, type TeacherDayRule } from "./lehrkraftregeln";
import { solverInputFromDb } from "./solver-input";
import { distribution, planningYear } from "./verteilung";
import { WEIGHT_PRESETS } from "./solverlauf";

describe("Tagesregeln je Lehrkraft – reine Regeln", () => {
  it("Verstöße beim Hinzufügen: Stunden am Tag, Anwesenheitstage; Kapazität der Woche", () => {
    const rule: TeacherDayRule = { maxPerDay: 2, maxDays: 2 };
    const week = new Map([
      [0, new Set([1, 2])],
      [1, new Set([3])],
    ]);
    expect(teacherViolationsWith(rule, week, 0, [3])).toEqual(["max"]);
    expect(teacherViolationsWith(rule, week, 0, [2])).toEqual([]); // dieselbe Stunde (Kopplung) zählt einmal
    expect(teacherViolationsWith(rule, week, 1, [4])).toEqual([]);
    expect(teacherViolationsWith(rule, week, 2, [1])).toEqual(["days"]);
    expect(teacherWeeklyCapacity(rule, 8)).toBe(4);
    expect(teacherWeeklyCapacity({ maxPerDay: null, maxDays: 3 }, 6)).toBe(18);
    expect(teacherLimitReasons({ rules: new Map([["t1", rule]]), names: new Map([["t1", "LIN"]]) }, ["t1", null, "t1"], [{ teacherId: "t1", weekday: 0, periodNr: 1 }, { teacherId: "t1", weekday: 0, periodNr: 2 }], 0, [3])).toEqual([
      "LIN: höchstens 2 Stunden am Tag",
    ]);
  });
});

let n = 0;
const unit = (groupId: string, teacherId: string, subjectId = "D"): SolverUnit => {
  const id = `u${++n}`;
  const part = { assignmentId: `a${n}`, groupIds: [groupId], teacherIds: [teacherId], subjectId, roomId: null, roomKind: null, homeRoomId: null, size: 25 };
  return { id, assignmentId: part.assignmentId, label: `${groupId} ${subjectId} ${n}`, groupIds: [groupId], teacherIds: [teacherId], subjectId, length: 1, roomId: null, roomKind: null, homeRoomId: null, size: 25, parts: [part] };
};
/** Band-Einheit: zwei Teile mit eigener Gruppe, Lehrkraft und Fach */
const band = (a: [string, string, string], b: [string, string, string]): SolverUnit => {
  const id = `b${++n}`;
  const part = ([g, t, s]: [string, string, string], i: number) => ({ assignmentId: `${id}-${i}`, groupIds: [g], teacherIds: [t], subjectId: s, roomId: null, roomKind: null, homeRoomId: null, size: 10 });
  const parts = [part(a, 0), part(b, 1)];
  return { id, assignmentId: parts[0]!.assignmentId, label: `Band ${n}`, groupIds: [a[0], b[0]], teacherIds: [a[1], b[1]], subjectId: a[2], length: 1, roomId: null, roomKind: null, homeRoomId: null, size: 20, parts };
};
const input = (us: SolverUnit[], over: Partial<SolverInput> = {}): SolverInput => ({
  weekdays: [0, 1, 2, 3, 4],
  periods: [1, 2, 3, 4, 5, 6],
  units: us,
  fixed: [],
  rooms: Array.from({ length: 4 }, (_, i) => ({ id: `R${i}`, kind: "klassenraum", capacity: 30 })),
  prefs: new Map(),
  conflicts: new Map(),
  classIds: new Set(["7a", "7b", "7c"]),
  names: new Map([["t1", "LIN"]]),
  seed: 3,
  ...over,
});
const teacherDays = (inp: SolverInput, r: ReturnType<typeof solve>, t: string) => {
  const byId = new Map(inp.units.map((u) => [u.id, u]));
  const out = new Map<number, number>();
  for (const p of r.placements) if (byId.get(p.unitId)!.teacherIds.includes(t)) out.set(p.weekday, (out.get(p.weekday) ?? 0) + 1);
  return out;
};

describe("Solver: Tagesregeln hart (SP2-04)", () => {
  it("höchstens n Stunden am Tag und höchstens n Anwesenheitstage – eine zu viel bleibt mit Grund „Tagesregel“ liegen", () => {
    const rule: TeacherDayRule = { maxPerDay: 3, maxDays: 2 };
    const us = [...Array.from({ length: 3 }, () => unit("7a", "t1")), ...Array.from({ length: 3 }, () => unit("7b", "t1"))];
    const ok = input(us, { teacherRules: new Map([["t1", rule]]) });
    const r = solve(ok);
    expect(r.unplaced).toEqual([]);
    expect(validate(ok, r.placements)).toEqual([]);
    const d = teacherDays(ok, r, "t1");
    expect(d.size).toBe(2);
    expect([...d.values()].every((x) => x <= 3)).toBe(true);
    const tooMany = input([...us, unit("7c", "t1")], { teacherRules: new Map([["t1", rule]]) });
    const r2 = solve(tooMany);
    expect(r2.unplaced).toHaveLength(1);
    expect(r2.unplaced[0]!.reason).toContain("Tagesregel LIN (höchstens 3 Std./Tag · höchstens 2 Tage)");
    expect(r2.unplaced[0]!.causes.find((c) => c.kind === "teacherDay")).toMatchObject({ id: "t1", free: 6, of: 30, blocked: 24 });
    // Vorprüfung: 7 Stunden auf höchstens 6 erlaubte
    expect(precheck(tooMany).find((f) => f.id === "t1" && f.message.includes("Tagesregel"))).toMatchObject({ severity: "error", demand: 7, free: 6 });
  });

  it("Band: die Regel gilt für jede beteiligte Lehrkraft (auch ein Teil des Bands)", () => {
    const rule: TeacherDayRule = { maxPerDay: 1, maxDays: null };
    const us = [band(["7a", "t1", "REL"], ["7b", "t2", "PHI"]), band(["7a", "t1", "REL"], ["7b", "t2", "PHI"]), unit("7c", "t2")];
    const inp = input(us, { teacherRules: new Map([["t2", rule]]) });
    const r = solve(inp);
    expect(r.unplaced).toEqual([]);
    expect([...teacherDays(inp, r, "t2").values()]).toEqual([1, 1, 1]);
  });

  it("ohne Regeln und mit Gewicht 0 unverändert: gleiche Lösung wie vorher", () => {
    const us = Array.from({ length: 20 }, (_, i) => unit(i % 2 ? "7a" : "7b", `t${i % 4}`, i % 3 ? "D" : "M"));
    const a = solve(input(us));
    const b = solve(input(us, { teacherRules: new Map(), weights: { ...DEFAULT_WEIGHTS } }));
    expect(b.placements).toEqual(a.placements);
    expect(b.breakdown.teacherDays).toBe(0);
    expect(b.breakdown.subjectSpread).toBe(0);
  });
});

describe("Solver: Fachverteilung und Anwesenheitstage weich (SP2-04)", () => {
  // Mathe 2 Stunden: ohne Gewicht dürfen sie an Folgetagen liegen, mit Gewicht nicht (Mo/Mi/Fr o. Ä.)
  const spread = (weights: Partial<typeof DEFAULT_WEIGHTS>) => {
    const us = [...Array.from({ length: 2 }, () => unit("7a", "t1", "M")), ...Array.from({ length: 12 }, (_, i) => unit("7a", `t${2 + (i % 3)}`, `F${i}`))];
    // Zeitwünsche ziehen Mathe auf Mo/Di, ohne Fachverteilung landet sie dort an Folgetagen
    const prefs = new Map([["subject:M", new Map([0, 1].flatMap((wd) => [1].map((p) => [`${wd}-${p}`, 3] as [string, number])))]]);
    const inp = input(us, { prefs, weights, names: new Map([["7a", "7a"], ["M", "Mathe"]]) });
    const r = solve(inp);
    const mDays = r.placements.filter((p) => inp.units.find((u) => u.id === p.unitId)!.subjectId === "M").map((p) => p.weekday);
    return { r, mDays: [...new Set(mDays)].sort() };
  };
  it("Fach an Folgetagen: ohne Gewicht Mo/Di, mit Gewicht über die Woche verteilt", () => {
    expect(spread({}).mDays).toEqual([0, 1]);
    const w = spread({ subjectSpread: 50 });
    const days = w.mDays;
    expect(days.some((d, i) => i > 0 && d === days[i - 1]! + 1)).toBe(false);
    expect(w.r.breakdown.subjectSpread).toBe(0);
    // Bewertungsposten mit lesbarem Text
    const s = spread({ subjectSpread: 1, pref: 10 });
    expect(s.r.items.find((i) => i.category === "subjectSpread")?.text).toBe("7a: Mathe an 1 vermeidbaren Folgetag");
  });

  it("Anwesenheitstage: mit Gewicht weniger Tage, Posten je Lehrkraft und Woche", () => {
    const us = Array.from({ length: 6 }, (_, i) => unit(`k${i}`, "t1"));
    const without = solve(input(us));
    const inp = input(us, { weights: { teacherDays: 20 } });
    const r = solve(inp);
    expect(teacherDays(inp, r, "t1").size).toBeLessThanOrEqual(teacherDays(input(us), without, "t1").size);
    expect(teacherDays(inp, r, "t1").size).toBe(1);
    expect(r.items.find((i) => i.category === "teacherDays")).toMatchObject({ cost: 20, text: "LIN: 1 Anwesenheitstag" });
  });

  it("Voreinstellungen: „ausgewogen“ ohne die neuen Kosten, lehrkräfteschonend/klassenkompakt mit", () => {
    expect(WEIGHT_PRESETS.ausgewogen).toMatchObject({ teacherDays: 0, subjectSpread: 0 });
    expect(WEIGHT_PRESETS.lehrkraefteschonend.teacherDays).toBeGreaterThan(0);
    expect(WEIGHT_PRESETS.klassenkompakt.subjectSpread).toBeGreaterThan(0);
  });
});

describe("Setzhilfe und Diagnose nennen die Tagesregel (SP2-04)", () => {
  const year = { validFrom: "2026-08-01", validUntil: "2027-07-31" };
  const lesson = (id: string, groupId: string, teacherId: string, weekday: number, periodNr: number): GridLesson => ({
    id,
    couplingId: null,
    groupId,
    groupName: groupId,
    subjectId: "M",
    subjectName: "Mathe",
    teacherId,
    teacherCode: "LIN",
    roomId: null,
    weekday,
    periodNr,
    week: "all",
    ...year,
  });
  const lessons = [lesson("l1", "7a", "t1", 0, 1), lesson("l2", "7b", "t1", 0, 2), lesson("l3", "7b", "t1", 1, 1)];
  const lim = { rules: new Map([["t1", { maxPerDay: 2, maxDays: 2 }]]), names: new Map([["t1", "LIN"]]) };

  it("Setzhilfe: Slot über der Tagesregel gesperrt mit Grund, auch beim Tausch-Partner", () => {
    const gi = { rows: [{ groupId: "7c", subjectId: "D", teacherId: "t1", roomId: null, week: "all" as const, ...year }], unitIds: [], lessons, rooms: [], weekdays: [0, 1, 2], periods: [1, 2, 3], teacherLimits: lim };
    expect(placementCell(gi, 0, 3)).toEqual({ state: "blocked", reasons: ["LIN: höchstens 2 Stunden am Tag"] });
    expect(placementCell(gi, 2, 1)).toEqual({ state: "blocked", reasons: ["LIN: höchstens 2 Anwesenheitstage je Woche"] });
    expect(placementCell(gi, 1, 2).state).toBe("free");
    // eine andere Lehrkraft ist frei
    expect(placementCell({ ...gi, rows: [{ ...gi.rows[0]!, teacherId: "t9" }] }, 0, 3).state).toBe("free");
  });

  it("Diagnose: Kategorie „Tagesregeln Lehrkräfte“ – Verstoß je Tag, zu viele Tage, Lehraufträge über der Kapazität", () => {
    const all = [...lessons, lesson("l4", "7c", "t1", 0, 3), lesson("l5", "7c", "t1", 2, 1)];
    const di: DiagnoseInput = {
      lessons: all.map(({ id, couplingId, groupId, subjectId, teacherId, roomId, weekday, periodNr, week }) => ({ id, couplingId, groupId, subjectId, teacherId, roomId, weekday, periodNr, week })),
      periods: [1, 2, 3],
      groups: [],
      teachers: [],
      subjects: [{ id: "M", name: "Mathe", roomKind: null }],
      rooms: [],
      distribution: { assignments: [], unmatched: [], curriculum: new Map() } as unknown as DiagnoseInput["distribution"],
      accounts: [{ id: "t1", code: "LIN", name: "Lindner", target: 5, assigned: 5, balance: 0, dayRule: { maxPerDay: 2, maxDays: 2 } }],
    };
    const found = diagnose(di).filter((f) => f.category === "teacherDay");
    expect(found.map((f) => f.message)).toEqual([
      "Mo: 3 Stunden – höchstens 2 Stunden am Tag",
      "3 Tage mit Unterricht – höchstens 2 Anwesenheitstage je Woche",
      "5 Stunden Lehraufträge, die Tagesregel erlaubt höchstens 4 (höchstens 2 Std./Tag · höchstens 2 Tage)",
    ]);
    expect(found[0]).toMatchObject({ severity: "error", target: { kind: "teacher", id: "t1", label: "LIN" } });
  });
});

describe("Tagesregeln je Lehrkraft (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Pflege: Prüfung, Konto zeigt die Regel, Solver-Eingabe und Setzhilfe laden sie, leere Angaben löschen sie, Audit", async () => {
    const year = (await planningYear(h.db))!;
    const [t] = await h.db.select({ id: users.id, code: users.shortCode }).from(users).where(eq(users.role, "lehrkraft")).limit(1);
    await expect(saveTeacherRule(h.db, "u-admin", year.id, t!.id, { maxPerDay: 0, maxDays: 6 })).rejects.toMatchObject({ fieldErrors: { maxPerDay: expect.any(String), maxDays: "1 bis 5 Tage" } });
    await expect(saveTeacherRule(h.db, "u-admin", year.id, "u-lea.schaefer", { maxPerDay: 4, maxDays: null })).rejects.toMatchObject({ fieldErrors: { teacherId: "Lehrkraft gibt es nicht" } });
    await saveTeacherRule(h.db, "u-admin", year.id, t!.id, { maxPerDay: 6, maxDays: 4 });
    expect((await listTeacherRules(h.db, year.id)).get(t!.id)).toEqual({ maxPerDay: 6, maxDays: 4 });
    const d = await distribution(h.db, year, today);
    const acc = (await deputyAccounts(h.db, year.id, d.teachers, 25.5)).find((a) => a.id === t!.id);
    expect(acc?.dayRule).toEqual({ maxPerDay: 6, maxDays: 4 });
    const input = await solverInputFromDb(h.db, year, today, { seed: 1 });
    expect(input.teacherRules?.get(t!.id)).toEqual({ maxPerDay: 6, maxDays: 4 });
    const lim = await loadTeacherLimits(h.db);
    expect(lim.names.get(t!.id)).toBe(t!.code);
    expect(await h.db.$count(auditLog, and(eq(auditLog.action, "stundenplan.deputy.day_rule"), eq(auditLog.target, t!.id)))).toBe(1);
    await saveTeacherRule(h.db, "u-admin", year.id, t!.id, { maxPerDay: null, maxDays: null });
    expect(await h.db.$count(timetableTeacherDayRules)).toBe(0);
  });

  it("Datenschutz: die Regel verschwindet mit dem Konto der Lehrkraft (Fremdschlüssel, Löschklasse wie das Deputat)", async () => {
    const year = (await planningYear(h.db))!;
    const [t] = await h.db.select({ id: users.id }).from(users).where(eq(users.role, "lehrkraft")).limit(1);
    await saveTeacherRule(h.db, "u-admin", year.id, t!.id, { maxPerDay: null, maxDays: 3 });
    await deleteAccounts(h.db, [t!.id]);
    expect(await h.db.$count(timetableTeacherDayRules)).toBe(0);
  });
});
