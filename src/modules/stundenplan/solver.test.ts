import { describe, expect, it } from "vitest";
import { createSolver, placementRooms, rng, solve, unitParts, validate, type SolverInput, type SolverUnit } from "./solver";

let n = 0;
const unit = (p: Partial<SolverUnit> & Pick<SolverUnit, "groupIds" | "teacherIds" | "subjectId">): SolverUnit => {
  const base = {
    id: `u${++n}`,
    assignmentId: `a-${p.groupIds.join("+")}-${p.subjectId}`,
    label: `${p.groupIds.join("+")} ${p.subjectId}`,
    length: 1 as const,
    roomId: null,
    roomKind: null,
    homeRoomId: null,
    size: 25,
    ...p,
  };
  return { ...base, parts: base.parts ?? [{ assignmentId: base.assignmentId, groupIds: base.groupIds, teacherIds: base.teacherIds, subjectId: base.subjectId, roomId: base.roomId, roomKind: base.roomKind, homeRoomId: base.homeRoomId, size: base.size }] };
};
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

  it("Doppelstunde nicht über die große Pause (SP-G-04a): ohne breakAfter wie bisher, mit nur an erlaubten Paaren", () => {
    const dbl = () => hours(3, { groupIds: ["7a"], teacherIds: ["BAU"], subjectId: "SP", length: 2 });
    // Dienstag 1–6 frei, sonst gesperrt: ohne Pausen passen drei Doppelstunden (1-2, 3-4, 5-6) – auch mit Pausen nach 2 und 4
    const onlyTuesday = new Map<string, number | null>();
    for (let wd = 0; wd < 5; wd++) for (let p = 1; p <= 6; p++) if (wd !== 1) onlyTuesday.set(`${wd}-${p}`, null);
    const prefs = new Map([["group:7a", onlyTuesday]]);
    const free = solve(base(dbl(), { prefs }));
    expect(free.unplaced).toEqual([]);
    const withBreaks = base(dbl(), { prefs, breakAfter: [2, 4] });
    const r = solve(withBreaks);
    expect(r.unplaced).toEqual([]);
    expect(r.placements.map((p) => p.periodNr).sort()).toEqual([1, 3, 5]);
    expect(validate(withBreaks, r.placements)).toEqual([]);
    // eine Platzierung über die Pause verletzt eine harte Regel
    expect(validate(withBreaks, [{ unitId: r.placements[0]!.unitId, weekday: 1, periodNr: 2, roomId: null }])).toHaveLength(1);
    // Pausen nach jeder Stunde: keine Doppelstunde möglich → nicht gesetzt, mit dem Grund „Doppelstunde“
    const none = solve(base(dbl(), { prefs, breakAfter: [1, 2, 3, 4, 5] }));
    expect(none.unplaced).toHaveLength(3);
    expect(none.unplaced[0]!.causes[0]).toMatchObject({ kind: "double", free: 0, of: 30 });
    expect(none.unplaced[0]!.reason).toBe("kein Slot frei – Doppelstunde: nur 0 von 30 Startstunden möglich");
  });

  it("nennt je nicht gesetzter Einheit die Beteiligten mit freien, belegten und gesperrten Slots (SP-G-03)", () => {
    // LIN hat nur Mi 1–2 frei (Rest gesperrt), die 7a ist Mi 1 fix belegt und hat Mi 2 Sperrzeit → nichts geht
    const blocked = new Map<string, number | null>();
    for (let wd = 0; wd < 5; wd++) for (let p = 1; p <= 6; p++) if (!(wd === 2 && p <= 2)) blocked.set(`${wd}-${p}`, null);
    const input = base(hours(1, { groupIds: ["7a"], teacherIds: ["LIN"], subjectId: "F" }), {
      prefs: new Map([
        ["teacher:LIN", blocked],
        ["group:7a", new Map([["2-2", null]])],
        ["subject:F", new Map([["0-1", null]])],
      ]),
      fixed: [{ groupId: "7a", teacherId: "X", roomId: "101", subjectId: "D", weekday: 2, periodNr: 1 }],
      conflicts: new Map([["7a", new Set(["kurs"])]]),
      names: new Map([
        ["LIN", "Lindner"],
        ["7a", "Klasse 7a"],
      ]),
    });
    const r = solve(input);
    expect(r.unplaced).toHaveLength(1);
    const u = r.unplaced[0]!;
    expect(u.causes.map((c) => [c.kind, c.label, c.free, c.of, c.busy, c.blocked])).toEqual([
      ["teacher", "Lehrkraft Lindner", 2, 30, 0, 28],
      ["group", "Klasse Klasse 7a", 28, 30, 1, 1],
      ["subject", "Fach F", 29, 30, 0, 1],
      ["conflict", "Kurse mit gemeinsamen Schüler:innen von Klasse 7a", 30, 30, 0, 0],
    ]);
    expect(u.reason).toBe("kein Slot frei – Lehrkraft Lindner: 2 von 30 Slots frei (28 gesperrt) · Klasse Klasse 7a: 28 von 30 Slots frei (1 belegt, 1 gesperrt) · Fach F: 29 von 30 Slots frei (1 gesperrt)");
  });

  it("Konstruktion in Scheiben liefert dieselbe Lösung wie in einem Stück; Hohlstunden-Kennzahlen", () => {
    const units = [
      ...hours(5, { groupIds: ["7a"], teacherIds: ["BRA"], subjectId: "D" }),
      ...hours(5, { groupIds: ["7b"], teacherIds: ["BRA"], subjectId: "E" }),
      ...hours(4, { groupIds: ["7a"], teacherIds: ["KLE"], subjectId: "M" }),
      ...hours(2, { groupIds: ["7b"], teacherIds: ["SCZ"], subjectId: "BI", roomKind: "nw", length: 2 }),
    ];
    const whole = solve(base(units));
    const sliced = createSolver(base(units));
    let calls = 0;
    let remaining = units.length;
    while (remaining > 0) {
      remaining = sliced.construct(() => false); // Budget sofort erschöpft → je Aufruf eine Einheit bewertet bzw. gesetzt
      calls++;
    }
    expect(calls).toBe(2 * units.length - 1);
    for (let left = sliced.total; left > 0; ) left = sliced.improve(Math.min(7, left));
    const r = sliced.result();
    expect(r.placements).toEqual(whole.placements);
    expect(r.score).toBe(whole.score);
    expect(sliced.score()).toBe(whole.score);
    expect(sliced.placed).toBe(units.length);
    expect(r.gaps).toEqual({ teacherTotal: r.breakdown.teacherGap / 3, teacherMax: expect.any(Number), classTotal: r.breakdown.classGap / 10, classMax: expect.any(Number) });
    expect(r.gaps.teacherMax).toBeLessThanOrEqual(r.gaps.teacherTotal);
  });

  it("Raum je Teil (SP-G-02): geteilte Klasse mit zwei Lehrkräften bekommt zwei Räume, gemeinsame Lehrkraft einen; alte Platzierungen ohne roomIds", () => {
    const need = { assignmentId: "a-sp", groupIds: ["7a"], subjectId: "SP", roomId: null, roomKind: "sport", homeRoomId: null, size: 14 };
    const split = unit({
      groupIds: ["7a"],
      teacherIds: ["BAU", "MEY"],
      subjectId: "SP",
      roomKind: "sport",
      parts: [
        { ...need, teacherIds: ["BAU"] },
        { ...need, teacherIds: ["MEY"] },
      ],
    });
    // Band-Vorgriff: zwei Teile mit derselben Lehrkraft (Teamteaching) teilen sich den Raum
    const team = unit({
      groupIds: ["7b"],
      teacherIds: ["RIC"],
      subjectId: "REL",
      parts: [
        { ...need, groupIds: ["7b"], subjectId: "REL", roomKind: null, homeRoomId: "102", teacherIds: ["RIC"] },
        { ...need, groupIds: ["7b"], subjectId: "REL", roomKind: null, homeRoomId: "102", teacherIds: ["RIC"] },
      ],
    });
    const rooms = [
      { id: "101", kind: "klassenraum", capacity: 30 },
      { id: "102", kind: "klassenraum", capacity: 30 },
      { id: "SP1", kind: "sport", capacity: 60 },
      { id: "SP2", kind: "sport", capacity: 60 },
    ];
    const input = base([split, team], { rooms });
    const r = solve(input);
    expect(r.unplaced).toEqual([]);
    expect(validate(input, r.placements)).toEqual([]);
    const at = new Map(r.placements.map((p) => [p.unitId, p]));
    const ps = at.get(split.id)!;
    expect(ps.roomIds).toEqual(["SP1", "SP2"]);
    expect(ps.roomId).toBe("SP1");
    expect(at.get(team.id)!.roomIds).toEqual(["102", "102"]);
    expect(r.breakdown.roomWish).toBe(0);
    expect(r.breakdown.noRoom).toBe(0);
    // nur eine Sporthalle: der zweite Teil bekommt einen Klassenraum (Raumwunsch verfehlt), nie denselben Raum
    const one = solve(base([split], { rooms: rooms.filter((x) => x.id !== "SP2") }));
    const p1 = one.placements[0]!;
    expect(p1.roomIds![0]).toBe("SP1");
    expect(p1.roomIds![1]).toBe("101");
    expect(one.breakdown.roomWish).toBe(4);
    expect(one.items.find((i) => i.category === "roomWish")!.text).toBe("7a SP (MEY): Raum 101 statt Wunsch");
    // ein zweiter Teil ohne irgendeinen freien Raum kostet „ohne Raum“ je Teil
    const none = solve(base([split], { rooms: [rooms[2]!] }));
    expect(none.breakdown.noRoom).toBe(20);
    expect(none.placements[0]!.roomIds).toEqual(["SP1", null]);
    // Platzierungen aus Läufen vor SP-09 (nur roomId): derselbe Raum für alle Teile; validate meldet Doppelbelegung je Raum
    expect(placementRooms({ roomId: "SP1" }, 2)).toEqual(["SP1", "SP1"]);
    expect(placementRooms({ roomId: "SP1", roomIds: ["SP1", "SP2"] }, 2)).toEqual(["SP1", "SP2"]);
    expect(placementRooms({ roomId: "SP1", roomIds: ["SP1"] }, 2)).toEqual(["SP1", "SP1"]);
    const other = unit({ groupIds: ["7b"], teacherIds: ["X"], subjectId: "SP", roomKind: "sport" });
    const clash = validate(base([split, other], { rooms }), [
      { unitId: split.id, weekday: 0, periodNr: 1, roomId: "SP1", roomIds: ["SP1", "SP2"] },
      { unitId: other.id, weekday: 0, periodNr: 1, roomId: "SP2" },
    ]);
    expect(clash).toEqual([`${other.label}: Raum SP2 doppelt belegt`]);
  });

  it("Teile (Q-SP-13): Einheit mit einem Teil je Lehrauftrag; unitParts ergänzt alte Einheiten ohne Teile", () => {
    const u = unit({ groupIds: ["7a", "7b"], teacherIds: ["RIC", "NEU"], subjectId: "REL", roomKind: "mu" });
    expect(u.parts).toEqual([{ assignmentId: u.assignmentId, groupIds: ["7a", "7b"], teacherIds: ["RIC", "NEU"], subjectId: "REL", roomId: null, roomKind: "mu", homeRoomId: null, size: 25 }]);
    expect(unitParts({ groupIds: ["7a"], teacherIds: ["X"], subjectId: "M" })).toEqual([{ assignmentId: "", groupIds: ["7a"], teacherIds: ["X"], subjectId: "M", roomId: null, roomKind: null, homeRoomId: null, size: 0 }]);
    expect(unitParts(u)).toBe(u.parts);
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
