import { describe, expect, it } from "vitest";
import { rng, solve, validate, type SolverInput, type SolverUnit } from "./solver";

let n = 0;
const unit = (p: Partial<SolverUnit> & Pick<SolverUnit, "groupIds" | "teacherIds" | "subjectId">): SolverUnit => ({
  id: `u${++n}`,
  assignmentId: `a-${p.groupIds.join("+")}-${p.subjectId}`,
  label: `${p.groupIds.join("+")} ${p.subjectId}`,
  length: 1,
  roomId: null,
  roomKind: null,
  homeRoomId: null,
  size: 25,
  ...p,
});
const hours = (k: number, p: Parameters<typeof unit>[0]) => Array.from({ length: k }, () => unit(p));

const base = (units: SolverUnit[], over: Partial<SolverInput> = {}): SolverInput => ({
  weekdays: [0, 1, 2, 3, 4],
  periods: [1, 2, 3, 4, 5, 6],
  units,
  fixed: [],
  rooms: [
    { id: "101", kind: "klassenraum", capacity: 30 },
    { id: "102", kind: "klassenraum", capacity: 30 },
    { id: "NW1", kind: "nw", capacity: 30 },
  ],
  prefs: new Map(),
  conflicts: new Map(),
  classIds: new Set(["7a", "7b"]),
  seed: 7,
  ...over,
});

describe("rng", () => {
  it("ist deterministisch", () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("solve", () => {
  it("setzt alles kollisionsfrei, ohne Hohlstunden in Klassen, deterministisch", () => {
    const units = [
      ...hours(4, { groupIds: ["7a"], teacherIds: ["BRA"], subjectId: "D", homeRoomId: "101" }),
      ...hours(4, { groupIds: ["7a"], teacherIds: ["KLE"], subjectId: "M", homeRoomId: "101" }),
      ...hours(4, { groupIds: ["7b"], teacherIds: ["BRA"], subjectId: "E", homeRoomId: "102" }),
      ...hours(4, { groupIds: ["7b"], teacherIds: ["KLE"], subjectId: "M", homeRoomId: "102" }),
      ...hours(2, { groupIds: ["7a"], teacherIds: ["SCZ"], subjectId: "BI", roomKind: "nw" }),
      ...hours(2, { groupIds: ["7b"], teacherIds: ["SCZ"], subjectId: "BI", roomKind: "nw" }),
    ];
    const input = base(units);
    const r = solve(input);
    expect(r.unplaced).toEqual([]);
    expect(r.placements).toHaveLength(units.length);
    expect(validate(input, r.placements)).toEqual([]);
    expect(r.breakdown.classGap).toBe(0);
    expect(r.breakdown.noRoom).toBe(0);
    // Biologie im NW-Raum, Klassen im Stammraum
    const roomOf = new Map(r.placements.map((p) => [p.unitId, p.roomId]));
    expect(units.filter((u) => u.subjectId === "BI").every((u) => roomOf.get(u.id) === "NW1")).toBe(true);
    expect(units.filter((u) => u.subjectId === "D").every((u) => roomOf.get(u.id) === "101")).toBe(true);
    // gleicher Input, gleicher Startwert → gleiche Lösung
    expect(solve(base(units)).placements).toEqual(r.placements);
  });

  it("Doppelstunde als Block, Kopplung belegt alle Gruppen und Lehrkräfte, Konfliktgruppen nie parallel", () => {
    const dbl = unit({ groupIds: ["7a"], teacherIds: ["BAU"], subjectId: "SP", length: 2 });
    const coupled = unit({ groupIds: ["7a", "7b"], teacherIds: ["RIC", "NEU"], subjectId: "REL" });
    const kursA = hours(3, { groupIds: ["kursA"], teacherIds: ["T1"], subjectId: "D" });
    const kursB = hours(3, { groupIds: ["kursB"], teacherIds: ["T2"], subjectId: "M" });
    const others = [
      ...hours(5, { groupIds: ["7a"], teacherIds: ["RIC"], subjectId: "D" }),
      ...hours(5, { groupIds: ["7b"], teacherIds: ["NEU"], subjectId: "E" }),
    ];
    const input = base([dbl, coupled, ...kursA, ...kursB, ...others], {
      periods: [1, 2, 3, 4],
      conflicts: new Map([
        ["kursA", new Set(["kursB"])],
        ["kursB", new Set(["kursA"])],
      ]),
    });
    const r = solve(input);
    expect(r.unplaced).toEqual([]);
    expect(validate(input, r.placements)).toEqual([]);
    const at = new Map(r.placements.map((p) => [p.unitId, p]));
    expect(at.get(dbl.id)!.periodNr).toBeLessThanOrEqual(3); // Block passt ins Raster
    const c = at.get(coupled.id)!;
    // in diesem Slot hat weder 7a noch 7b, RIC oder NEU etwas anderes
    const same = r.placements.filter((p) => p.weekday === c.weekday && p.periodNr === c.periodNr && p.unitId !== coupled.id);
    expect(same.every((p) => ![...others, dbl].some((u) => u.id === p.unitId))).toBe(true);
    const slotsA = new Set(kursA.map((u) => `${at.get(u.id)!.weekday}-${at.get(u.id)!.periodNr}`));
    expect(kursB.some((u) => slotsA.has(`${at.get(u.id)!.weekday}-${at.get(u.id)!.periodNr}`))).toBe(false);
  });

  it("gesperrte Zeiten und fixierte Stunden sind hart, Zeitwünsche werden bevorzugt", () => {
    const units = hours(3, { groupIds: ["7a"], teacherIds: ["WAG"], subjectId: "F" });
    const blockedAll = new Map<string, number | null>();
    for (let wd = 0; wd < 5; wd++) for (let p = 1; p <= 6; p++) if (!(wd === 2 && p <= 3)) blockedAll.set(`${wd}-${p}`, null);
    blockedAll.set("2-2", 3);
    const input = base(units, {
      prefs: new Map([["teacher:WAG", blockedAll]]),
      fixed: [{ groupId: "7a", teacherId: "X", roomId: "101", subjectId: "D", weekday: 2, periodNr: 1 }],
    });
    const r = solve(input);
    // nur Mi 1–3 frei, Mi 1 ist fix belegt → zwei Stunden passen, eine nicht
    expect(r.placements.map((p) => `${p.weekday}-${p.periodNr}`).sort()).toEqual(["2-2", "2-3"]);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0]!.reason).toMatch(/kein Slot/);
    expect(r.breakdown.pref).toBe(-3 * 2);
  });

  it("erklärt die Bewertung: Fach mehrfach am Tag, späte Stunden, Raumwunsch", () => {
    // 6 Stunden Mathe an 1 Tag mit 6 Stunden → zwangsläufig mehrfach am Tag und spät
    const units = hours(6, { groupIds: ["7a"], teacherIds: ["KLE"], subjectId: "M", roomId: "NW1" });
    const input = base(units, {
      weekdays: [0],
      periods: [1, 2, 3, 4, 5, 6, 7],
      weights: { lateFrom: 5 },
      names: new Map([
        ["7a", "Klasse 7a"],
        ["M", "Mathematik"],
      ]),
    });
    const r = solve(input);
    expect(r.unplaced).toEqual([]);
    expect(r.breakdown.subjectTwice).toBeGreaterThan(0);
    expect(r.items[0]!.cost).toBeGreaterThanOrEqual(r.items.at(-1)!.cost);
    expect(r.items.find((i) => i.category === "subjectTwice")!.text).toBe("Klasse 7a Mo: Mathematik 6× am Tag");
    expect(r.breakdown.roomWish).toBe(0);
    expect(r.score).toBe(Object.values(r.breakdown).reduce((s, x) => s + x, 0));
  });
});
