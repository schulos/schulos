// SP2-03: Tagesgrenzen und Ganztag je Jahrgang – reine Regeln, Solver (hart, Erklärung), Vorprüfung, Setzhilfe und Diagnose.
import { describe, expect, it } from "vitest";
import { solve, validate, type SolverInput, type SolverUnit } from "./solver";
import { precheck } from "./solver-check";
import { placementCell, type GridLesson } from "./setzhilfe";
import { diagnose, type DiagnoseInput } from "./diagnose";
import { gradeRulesTemplate } from "@/core/school/templates";
import { dayLimitReasons, dayRuleFor, violationsWith, weeklyCapacity, type DayLimits, type DayRule } from "./tagesgrenzen";

const grid = (n: number, breakAfter?: number) =>
  Array.from({ length: n }, (_, i) => {
    // 45 Minuten, 5 Minuten Pause, nach `breakAfter` 45 Minuten Mittagspause
    const start = 8 * 60 + i * 50 + (breakAfter !== undefined && i >= breakAfter ? 40 : 0);
    const t = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return { nr: i + 1, startsAt: t(start), endsAt: t(start + 45) };
  });

describe("dayRuleFor / violationsWith / weeklyCapacity", () => {
  it("Mittagspause im Zeitraster: keine Mittagsstunde, Nachmittag ab der Stunde danach", () => {
    expect(dayRuleFor({ maxPerDay: 8, afternoonsPerWeek: 3, lunchAfterPeriod: 6 }, grid(8, 6))).toEqual({ maxPerDay: 8, afternoonsPerWeek: 3, lunchPeriod: null, afternoonFrom: 7 });
  });
  it("durchgehendes Raster: Stunde nach dem Mittag bleibt frei bei Unterricht danach", () => {
    expect(dayRuleFor({ maxPerDay: null, afternoonsPerWeek: 2, lunchAfterPeriod: 6 }, grid(9))).toEqual({ maxPerDay: null, afternoonsPerWeek: 2, lunchPeriod: 7, afternoonFrom: 8 });
    // ohne Mittagsangabe keine Nachmittagsgrenze; ohne jede Angabe keine Regel
    expect(dayRuleFor({ maxPerDay: 6, afternoonsPerWeek: 2, lunchAfterPeriod: null }, grid(8))).toMatchObject({ afternoonsPerWeek: null, afternoonFrom: null });
    expect(dayRuleFor({ maxPerDay: null, afternoonsPerWeek: null, lunchAfterPeriod: null }, grid(8))).toBeNull();
  });
  it("Verstöße beim Hinzufügen: Tagesmaximum, Mittagsstunde, Nachmittage je Woche", () => {
    const rule: DayRule = { maxPerDay: 3, afternoonsPerWeek: 1, lunchPeriod: 4, afternoonFrom: 5 };
    const week = new Map([
      [0, new Set([1, 2, 5])],
      [1, new Set([1, 2])],
    ]);
    expect(violationsWith(rule, week, 0, [3])).toEqual(["max"]);
    expect(violationsWith(rule, week, 1, [4])).toEqual([]); // Mittagsstunde ohne Unterricht danach: erlaubt
    expect(violationsWith(rule, new Map([[1, new Set([4])]]), 1, [5])).toEqual(["lunch"]);
    expect(violationsWith(rule, week, 1, [5])).toEqual(["afternoons"]); // Mo hat schon Nachmittag
    expect(violationsWith(rule, week, 0, [])).toEqual([]);
  });
  it("Wochenkapazität: Nachmittagstage voll (ohne Mittagsstunde), übrige Tage bis zum Mittag, je Tag höchstens maxPerDay", () => {
    expect(weeklyCapacity({ maxPerDay: 8, afternoonsPerWeek: 3, lunchPeriod: null, afternoonFrom: 7 }, [1, 2, 3, 4, 5, 6, 7, 8])).toBe(3 * 8 + 2 * 6);
    expect(weeklyCapacity({ maxPerDay: 7, afternoonsPerWeek: 2, lunchPeriod: 7, afternoonFrom: 8 }, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(2 * 7 + 3 * 7);
    expect(weeklyCapacity({ maxPerDay: 5, afternoonsPerWeek: null, lunchPeriod: null, afternoonFrom: null }, [1, 2, 3, 4, 5, 6])).toBe(25);
  });
  it("Katalog: Sek I mit Vorgaben, Oberstufe ohne; Halbtag ohne Mittag/Nachmittage", () => {
    expect(gradeRulesTemplate("gesamtschule", [5, 7, 11], 8)).toEqual([
      { grade: 5, maxPerDay: 7, lunchAfterPeriod: 6, afternoonsPerWeek: 3 },
      { grade: 7, maxPerDay: 8, lunchAfterPeriod: 6, afternoonsPerWeek: 3 },
    ]);
    expect(gradeRulesTemplate("gymnasium", [9], 8)[0]).toMatchObject({ afternoonsPerWeek: 2 });
    expect(gradeRulesTemplate("realschule", [9], 6)[0]).toEqual({ grade: 9, maxPerDay: 6, lunchAfterPeriod: null, afternoonsPerWeek: null });
  });
});

let n = 0;
const unit = (groupIds: string[], subjectId = "D"): SolverUnit => {
  const id = `u${++n}`;
  const part = { assignmentId: `a${n}`, groupIds, teacherIds: [`t${n}`], subjectId, roomId: null, roomKind: null, homeRoomId: null, size: 25 };
  return { id, assignmentId: part.assignmentId, label: `${groupIds.join("+")} ${subjectId} ${n}`, groupIds, teacherIds: part.teacherIds, subjectId, length: 1, roomId: null, roomKind: null, homeRoomId: null, size: 25, parts: [part] };
};
const units = (k: number, groupIds: string[]) => Array.from({ length: k }, () => unit(groupIds));
const input = (us: SolverUnit[], periods: number[], rule: DayRule, over: Partial<SolverInput> = {}): SolverInput => ({
  weekdays: [0, 1, 2, 3, 4],
  periods,
  units: us,
  fixed: [],
  rooms: Array.from({ length: 4 }, (_, i) => ({ id: `R${i}`, kind: "klassenraum", capacity: 30 })),
  prefs: new Map(),
  conflicts: new Map(),
  classIds: new Set(["7a"]),
  gradeOf: new Map([["7a", 7]]),
  dayRules: new Map([["7a", rule]]),
  names: new Map([["7a", "7a"]]),
  seed: 3,
  ...over,
});
const days = (inp: SolverInput, r: ReturnType<typeof solve>, group = "7a") => {
  const out = new Map<number, number[]>();
  const byId = new Map(inp.units.map((u) => [u.id, u]));
  for (const p of r.placements) if (byId.get(p.unitId)!.groupIds.includes(group) || group === "*") out.set(p.weekday, [...(out.get(p.weekday) ?? []), p.periodNr].sort());
  return out;
};

describe("Solver: Tagesgrenzen hart (SP2-03)", () => {
  it("höchstens n Stunden am Tag – passt genau, eine zu viel bleibt mit Grund „Tagesgrenzen“ liegen", () => {
    const rule: DayRule = { maxPerDay: 2, afternoonsPerWeek: null, lunchPeriod: null, afternoonFrom: null };
    const ok = input(units(10, ["7a"]), [1, 2, 3, 4, 5, 6], rule);
    const r = solve(ok);
    expect(r.unplaced).toEqual([]);
    expect(validate(ok, r.placements)).toEqual([]);
    expect([...days(ok, r).values()].map((d) => d.length)).toEqual([2, 2, 2, 2, 2]);
    const tooMany = input(units(11, ["7a"]), [1, 2, 3, 4, 5, 6], rule);
    const r2 = solve(tooMany);
    expect(r2.unplaced).toHaveLength(1);
    expect(r2.unplaced[0]!.reason).toContain("Tagesgrenzen 7a (höchstens 2 Std./Tag)");
    // gesperrt sind alle Slots außerhalb der eigenen Stunden (dort ist die Klasse belegt – das zeigt die Zeile der Klasse)
    expect(r2.unplaced[0]!.causes.find((c) => c.kind === "day")).toMatchObject({ free: 10, of: 30, blocked: 20 });
  });

  it("Mittagsstunde bleibt frei, wenn danach Unterricht liegt; höchstens ein Nachmittag", () => {
    // Raster 1–4, Mittag nach der 2. ohne Pause → 3. = Mittagsstunde, 4. = Nachmittag; je Tag also höchstens 3 Stunden
    const rule: DayRule = { maxPerDay: null, afternoonsPerWeek: 1, lunchPeriod: 3, afternoonFrom: 4 };
    const inp = input(units(15, ["7a"]), [1, 2, 3, 4], rule);
    const r = solve(inp);
    expect(r.unplaced).toEqual([]);
    for (const d of days(inp, r).values()) expect(d.includes(3) && d.includes(4)).toBe(false);
    expect([...days(inp, r).values()].filter((d) => d.includes(4)).length).toBeLessThanOrEqual(1);
    expect(validate(inp, r.placements)).toEqual([]);
    // Vorprüfung: 16 Stunden auf höchstens 15 erlaubte → Fehler mit den Tagesgrenzen
    const pre = precheck(input(units(16, ["7a"]), [1, 2, 3, 4], rule));
    expect(pre.find((f) => f.id === "7a" && f.message.includes("Tagesgrenzen"))).toMatchObject({ severity: "error", demand: 16, free: 15 });
  });

  it("Kurse des Jahrgangs zählen für die Klasse mit – auch als Band-Teil", () => {
    const rule: DayRule = { maxPerDay: 1, afternoonsPerWeek: null, lunchPeriod: null, afternoonFrom: null };
    const inp = input([...units(3, ["7a"]), ...units(3, ["7-wp"])], [1, 2, 3, 4, 5, 6], rule, {
      gradeOf: new Map([["7a", 7], ["7-wp", 7]]),
      // Schüler:innen der Klasse sind im Kurs – beide nie parallel
      conflicts: new Map([["7a", new Set(["7-wp"])], ["7-wp", new Set(["7a"])]]),
    });
    const r = solve(inp);
    expect(r.placements).toHaveLength(5);
    expect(r.unplaced).toHaveLength(1);
    const all = new Map<number, number>();
    for (const p of r.placements) all.set(p.weekday, (all.get(p.weekday) ?? 0) + 1);
    expect([...all.values()].every((x) => x === 1)).toBe(true);
  });

  it("ohne Regeln unverändert: gleiche Lösung wie ohne `dayRules`", () => {
    const us = units(20, ["7a"]);
    const a = solve(input(us, [1, 2, 3, 4, 5, 6], { maxPerDay: null, afternoonsPerWeek: null, lunchPeriod: null, afternoonFrom: null }, { dayRules: undefined }));
    const b = solve(input(us, [1, 2, 3, 4, 5, 6], { maxPerDay: null, afternoonsPerWeek: null, lunchPeriod: null, afternoonFrom: null }, { dayRules: new Map() }));
    expect(a.placements).toEqual(b.placements);
  });
});

const limits = (rule: DayRule): DayLimits => ({
  rules: new Map([["7a", rule]]),
  gradeOf: new Map([
    ["7a", 7],
    ["7-wp", 7],
  ]),
  classIds: new Set(["7a"]),
  names: new Map([["7a", "7a"]]),
});

describe("Setzhilfe und Diagnose nennen die Regel (SP2-03)", () => {
  const year = { validFrom: "2026-08-01", validUntil: "2027-07-31" };
  const lesson = (id: string, groupId: string, weekday: number, periodNr: number): GridLesson => ({
    id,
    couplingId: null,
    groupId,
    groupName: groupId,
    subjectId: "M",
    subjectName: "Mathe",
    teacherId: `t-${id}`,
    teacherCode: null,
    roomId: null,
    weekday,
    periodNr,
    week: "all",
    ...year,
  });
  const lessons = [lesson("l1", "7a", 0, 1), lesson("l2", "7-wp", 0, 2)];
  const rule: DayRule = { maxPerDay: 2, afternoonsPerWeek: null, lunchPeriod: null, afternoonFrom: null };

  it("Setzhilfe: Slot über der Tagesgrenze ist gesperrt mit Grund, andere Tage frei", () => {
    const gi = { rows: [{ groupId: "7a", subjectId: "D", teacherId: "t9", roomId: null, week: "all" as const, ...year }], unitIds: [], lessons, rooms: [], weekdays: [0, 1], periods: [1, 2, 3], dayLimits: limits(rule) };
    expect(placementCell(gi, 0, 3)).toEqual({ state: "blocked", reasons: ["7a: höchstens 2 Stunden am Tag"] });
    expect(placementCell(gi, 1, 3).state).toBe("free");
    expect(dayLimitReasons(limits(rule), ["7-wp"], lessons, 0, [3])).toEqual(["7a: höchstens 2 Stunden am Tag"]);
  });

  it("Diagnose: Kategorie „Tagesgrenzen“ mit Verstoß je Tag und zu vielen Wochenstunden", () => {
    const di: DiagnoseInput = {
      lessons: [...lessons, lesson("l3", "7a", 0, 3)].map(({ id, couplingId, groupId, subjectId, teacherId, roomId, weekday, periodNr, week }) => ({ id, couplingId, groupId, subjectId, teacherId, roomId, weekday, periodNr, week })),
      periods: [1, 2, 3],
      groups: [{ id: "7a", name: "7a", kind: "klasse", gradeLevel: 7, size: 25 }],
      teachers: [],
      subjects: [{ id: "M", name: "Mathe", roomKind: null }],
      rooms: [],
      distribution: { assignments: [], unmatched: [], curriculum: new Map() } as unknown as DiagnoseInput["distribution"],
      accounts: [],
      dayLimits: limits(rule),
    };
    const day = diagnose(di).filter((f) => f.category === "day");
    expect(day.map((f) => f.message)).toEqual(["Mo: 3 Stunden – höchstens 2 Stunden am Tag"]);
    expect(day[0]).toMatchObject({ severity: "error", target: { kind: "group", id: "7a" } });
  });
});
