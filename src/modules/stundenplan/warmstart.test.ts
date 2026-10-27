import { describe, expect, it } from "vitest";
import { createSolver, solve, solveWarm, unchangedUnits, validate, type SolverInput, type SolverUnit, type UnitPart } from "./solver";
import { startPlacements, type StartLesson } from "./warmstart";

/** Einheiten eines Lehrauftrags wie `unitsFrom()`: `a#d0` … Doppelstunden, dann `a#e0` … Einzelstunden. */
const assignment = (id: string, g: string, s: string, t: string, hours: number, doubles = 0, extra: Partial<UnitPart> = {}): SolverUnit[] => {
  const part: UnitPart = {
    assignmentId: id,
    groupIds: [g],
    teacherIds: [t],
    subjectId: s,
    roomId: null,
    roomKind: null,
    homeRoomId: null,
    size: 25,
    ...extra,
  };
  const common = {
    assignmentId: id,
    label: `${g} ${s}`,
    groupIds: [g],
    teacherIds: [t],
    subjectId: s,
    roomId: part.roomId,
    roomKind: part.roomKind,
    homeRoomId: part.homeRoomId,
    size: 25,
    parts: [part],
  };
  return [
    ...Array.from({ length: doubles }, (_, i) => ({
      ...common,
      id: `${id}#d${i}`,
      length: 2 as const,
    })),
    ...Array.from({ length: hours - 2 * doubles }, (_, i) => ({
      ...common,
      id: `${id}#e${i}`,
      length: 1 as const,
    })),
  ];
};

const input = (units: SolverUnit[], over: Partial<SolverInput> = {}): SolverInput => ({
  weekdays: [0, 1, 2, 3, 4],
  periods: [1, 2, 3, 4, 5, 6],
  breakAfter: [2, 4],
  units,
  fixed: [],
  rooms: [
    { id: "101", kind: "klassenraum", capacity: 30 },
    { id: "102", kind: "klassenraum", capacity: 30 },
    { id: "103", kind: "klassenraum", capacity: 30 },
  ],
  prefs: new Map(),
  conflicts: new Map(),
  classIds: new Set(["7a", "7b"]),
  seed: 3,
  ...over,
});

const lesson = (g: string, s: string, t: string | null, wd: number, nr: number, roomId: string | null = "101"): StartLesson => ({
  groupId: g,
  subjectId: s,
  teacherId: t,
  roomId,
  weekday: wd,
  periodNr: nr,
});

describe("startPlacements (SQ-02)", () => {
  it("ordnet Entwurfsstunden den Einheiten zu: Doppelstunde auf zwei Folgestunden ohne große Pause, Rest einzeln, Raum aus der Stunde", () => {
    const units = assignment("a1", "7a", "D", "BRA", 4, 1);
    // Mo 2/3 liegt über der großen Pause nach der 2. – Doppelstunde daher Di 3/4
    const r = startPlacements(input(units), [
      lesson("7a", "D", "BRA", 0, 2),
      lesson("7a", "D", "BRA", 0, 3, "102"),
      lesson("7a", "D", "BRA", 1, 3),
      lesson("7a", "D", "BRA", 1, 4),
    ]);
    expect(r.placements).toEqual([
      {
        unitId: "a1#d0",
        weekday: 1,
        periodNr: 3,
        roomId: "101",
        roomIds: ["101"],
      },
      {
        unitId: "a1#e0",
        weekday: 0,
        periodNr: 2,
        roomId: "101",
        roomIds: ["101"],
      },
      {
        unitId: "a1#e1",
        weekday: 0,
        periodNr: 3,
        roomId: "102",
        roomIds: ["102"],
      },
    ]);
    expect(r.unused).toBe(0);
    expect(r.open).toBe(0);
  });

  it("offene Stunden bleiben nicht gesetzt, überzählige Stunden zählen als unbenutzt; zwei Lehraufträge gleicher Gruppe/Fach nach Lehrkraft getrennt", () => {
    const units = [...assignment("a1", "7a", "M", "KLE", 3), ...assignment("a2", "7a", "M", "SCZ", 1)];
    const r = startPlacements(input(units), [lesson("7a", "M", "SCZ", 0, 1), lesson("7a", "M", "KLE", 1, 1), lesson("7a", "M", "KLE", 2, 1)]);
    // erst Stunden mit passender Lehrkraft: a2 bekommt die SCZ-Stunde, die dritte Stunde von a1 bleibt offen
    expect(r.placements.map((p) => [p.unitId, p.weekday])).toEqual([
      ["a1#e0", 1],
      ["a1#e1", 2],
      ["a2#e0", 0],
    ]);
    expect(r.open).toBe(1);
    expect(r.unused).toBe(0);
    // von Hand umbesetzte Stunde (andere Lehrkraft) zählt im zweiten Durchgang für den Lehrauftrag
    const moved = startPlacements(input(units), [lesson("7a", "M", "SCZ", 0, 1), lesson("7a", "M", "KLE", 1, 1), lesson("7a", "M", "XYZ", 2, 1), lesson("7a", "M", "KLE", 3, 1)]);
    expect(moved.placements.map((p) => [p.unitId, p.weekday])).toEqual([
      ["a1#e0", 1],
      ["a1#e1", 3],
      ["a1#e2", 2],
      ["a2#e0", 0],
    ]);
    expect(moved.open).toBe(0);
  });

  it("Band: ein Platz für die Einheit, Raum je Teil aus der Stunde des Teils", () => {
    const parts: UnitPart[] = [
      {
        assignmentId: "m1",
        groupIds: ["k1"],
        teacherIds: ["T1"],
        subjectId: "BI",
        roomId: null,
        roomKind: null,
        homeRoomId: null,
        size: 20,
      },
      {
        assignmentId: "m2",
        groupIds: ["k2"],
        teacherIds: ["T2"],
        subjectId: "CH",
        roomId: null,
        roomKind: null,
        homeRoomId: null,
        size: 20,
      },
    ];
    const band: SolverUnit = {
      id: "b1#e0",
      assignmentId: "m1",
      label: "Band",
      groupIds: ["k1", "k2"],
      teacherIds: ["T1", "T2"],
      subjectId: "BI",
      length: 1,
      roomId: null,
      roomKind: null,
      homeRoomId: null,
      size: 40,
      parts,
    };
    const r = startPlacements(input([band]), [lesson("k1", "BI", "T1", 3, 5, "102"), lesson("k2", "CH", "T2", 3, 5, "103")]);
    expect(r.placements).toEqual([
      {
        unitId: "b1#e0",
        weekday: 3,
        periodNr: 5,
        roomId: "102",
        roomIds: ["102", "103"],
      },
    ]);
  });
});

describe("Warmstart (SQ-02)", () => {
  const school = () => {
    const units = [
      ...assignment("d7a", "7a", "D", "BRA", 4, 1, { homeRoomId: "101" }),
      ...assignment("m7a", "7a", "M", "KLE", 4, 0, { homeRoomId: "101" }),
      ...assignment("e7a", "7a", "E", "NEU", 3, 0, { homeRoomId: "101" }),
      ...assignment("e7b", "7b", "E", "BRA", 4, 0, { homeRoomId: "102" }),
      ...assignment("m7b", "7b", "M", "KLE", 4, 1, { homeRoomId: "102" }),
      ...assignment("d7b", "7b", "D", "NEU", 3, 0, { homeRoomId: "102" }),
    ];
    return input(units, {
      fixed: [
        {
          groupId: "7a",
          teacherId: "FIX",
          roomId: "103",
          subjectId: "KU",
          weekday: 0,
          periodNr: 1,
        },
      ],
    });
  };

  it("verbessert einen schlechten Start, nie schlechter, setzt nicht gesetzte Einheiten, Fixiertes bleibt, deterministisch", () => {
    const x = school();
    // Start: alles am Montag/Dienstag gestapelt (Hohlstunden, Fach mehrfach), zwei Einheiten fehlen
    const start = x.units.slice(0, -2).map((u, i) => ({
      unitId: u.id,
      weekday: i % 5,
      periodNr: 2 + (i % 4),
      roomId: null,
    }));
    const solver = createSolver(x);
    const info = solver.warmStart(start);
    expect(info.startUnplaced).toBeGreaterThanOrEqual(2);
    let last = { unplaced: info.startUnplaced, score: info.startScore };
    for (let i = 0; i < 40; i++) {
      solver.lns(1);
      const r = solver.result();
      // jede Runde: weniger nicht gesetzt oder bei gleich vielen keine schlechtere Bewertung
      expect(r.unplaced.length < last.unplaced || (r.unplaced.length === last.unplaced && r.score <= last.score)).toBe(true);
      last = { unplaced: r.unplaced.length, score: r.score };
    }
    const r = solver.result();
    expect(r.unplaced).toEqual([]);
    expect(r.warm).toMatchObject({
      rounds: 40,
      startUnplaced: info.startUnplaced,
    });
    expect(r.warm!.accepted).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(info.startScore);
    expect(validate(x, r.placements)).toEqual([]);
    // fixierte Stunde Mo 1 der 7a: keine Einheit der 7a dort
    const byId = new Map(x.units.map((u) => [u.id, u]));
    expect(r.placements.filter((p) => p.weekday === 0 && p.periodNr <= 1 && byId.get(p.unitId)!.groupIds.includes("7a") && p.periodNr + byId.get(p.unitId)!.length > 1)).toEqual(
      [],
    );
    expect(solveWarm(x, start, "alle", 40)).toEqual(r);
  });

  it("vom Ergebnis eines Neu-Laufs: nie schlechter, die meisten Einheiten bleiben, wo sie sind", () => {
    const x = school();
    const neu = solve(x);
    const r = solveWarm(x, neu.placements);
    expect(r.unplaced.length).toBeLessThanOrEqual(neu.unplaced.length);
    expect(r.score).toBeLessThanOrEqual(neu.score);
    expect(validate(x, r.placements)).toEqual([]);
    expect(unchangedUnits(neu.placements, r.placements) / neu.placements.length).toBeGreaterThan(0.5);
  });

  it("ein unzulässiger Start (Lehrkraft doppelt) wird nicht übernommen – die Einheit gilt als nicht gesetzt und wird neu gesetzt", () => {
    const x = school();
    const neu = solve(x);
    const [a, b] = neu.placements.filter((p) => p.unitId.startsWith("m7"));
    const clash = neu.placements.map((p) => (p.unitId === b!.unitId ? { ...b!, weekday: a!.weekday, periodNr: a!.periodNr } : p));
    const solver = createSolver(x);
    expect(solver.warmStart(clash).startUnplaced).toBe(1);
    solver.lns(Number.POSITIVE_INFINITY);
    const r = solver.result();
    expect(r.unplaced).toEqual([]);
    expect(validate(x, r.placements)).toEqual([]);
  });

  it("„nur schwache Bereiche“: was nichts kostet (Klasse 7b ohne Hohlstunden, eigene Lehrkräfte), bleibt unverändert; 7a wird besser", () => {
    const units = [
      ...assignment("d7a", "7a", "D", "A1", 5, 0, { homeRoomId: "101" }),
      ...assignment("m7a", "7a", "M", "A2", 5, 0, { homeRoomId: "101" }),
      ...assignment("d7b", "7b", "D", "B1", 5, 0, { homeRoomId: "102" }),
      ...assignment("m7b", "7b", "M", "B2", 5, 0, { homeRoomId: "102" }),
    ];
    const x = input(units, { seed: 5 });
    // 7b jeden Tag 1./2. Stunde (keine Kosten); 7a jeden Tag 1. und 3. Stunde (Hohlstunde)
    const start = units.map((u) => {
      const i = Number(u.id.split("#e")[1]);
      const first = u.id.startsWith("d");
      return {
        unitId: u.id,
        weekday: i,
        periodNr: first ? 1 : u.groupIds[0] === "7a" ? 3 : 2,
        roomId: u.groupIds[0] === "7a" ? "101" : "102",
      };
    });
    const r = solveWarm(x, start, "schwach");
    expect(r.warm!.scope).toBe("schwach");
    expect(validate(x, r.placements)).toEqual([]);
    expect(r.breakdown.classGap).toBe(0);
    expect(r.score).toBeLessThan(r.warm!.startScore);
    const b = start.filter((p) => p.unitId.endsWith("7b") || p.unitId.includes("7b#"));
    expect(b).toHaveLength(10);
    expect(unchangedUnits(b, r.placements)).toBe(10);
  });
});
