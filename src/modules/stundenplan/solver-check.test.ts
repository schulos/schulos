import { describe, expect, it } from "vitest";
import type { SolverInput, SolverUnit } from "./solver";
import { longBreaksAfter, precheck } from "./solver-check";

let n = 0;
const unit = (p: Partial<SolverUnit> & Pick<SolverUnit, "groupIds" | "teacherIds" | "subjectId">): SolverUnit => {
  const base = { id: `u${++n}`, assignmentId: "a", label: `${p.groupIds.join("+")} ${p.subjectId}`, length: 1 as const, roomId: null, roomKind: null, homeRoomId: null, size: 25, ...p };
  return { ...base, parts: [{ assignmentId: "a", groupIds: base.groupIds, teacherIds: base.teacherIds, subjectId: base.subjectId, roomId: base.roomId, roomKind: base.roomKind, homeRoomId: base.homeRoomId, size: base.size }] };
};
const hours = (k: number, p: Parameters<typeof unit>[0]) => Array.from({ length: k }, () => unit(p));
const input = (units: SolverUnit[], over: Partial<SolverInput> = {}): SolverInput => ({
  weekdays: [0, 1, 2, 3, 4],
  periods: [1, 2, 3, 4, 5, 6],
  units,
  fixed: [],
  rooms: [{ id: "101", kind: "klassenraum", capacity: 30 }],
  prefs: new Map(),
  conflicts: new Map(),
  classIds: new Set(["7a"]),
  names: new Map([
    ["LIN", "Lindner"],
    ["7a", "Klasse 7a"],
  ]),
  ...over,
});

describe("longBreaksAfter", () => {
  it("große Pausen (ab 20 Minuten) aus dem Zeitraster – Demo-Raster: nach der 2., 4. und 6. Stunde", () => {
    const grid = [
      { nr: 1, startsAt: "08:00", endsAt: "08:45" },
      { nr: 2, startsAt: "08:50", endsAt: "09:35" },
      { nr: 3, startsAt: "09:55", endsAt: "10:40" },
      { nr: 4, startsAt: "10:45", endsAt: "11:30" },
      { nr: 5, startsAt: "11:50", endsAt: "12:35" },
      { nr: 6, startsAt: "12:40", endsAt: "13:25" },
      { nr: 7, startsAt: "14:15", endsAt: "15:00" },
      { nr: 8, startsAt: "15:05", endsAt: "15:50" },
    ];
    expect(longBreaksAfter(grid)).toEqual([2, 4, 6]);
    expect(longBreaksAfter(grid, 30)).toEqual([6]);
    expect(longBreaksAfter([grid[3]!, grid[0]!, grid[2]!, grid[1]!])).toEqual([2]); // Reihenfolge egal
    expect(longBreaksAfter([])).toEqual([]);
    expect(longBreaksAfter([grid[0]!])).toEqual([]);
  });
});

describe("precheck", () => {
  it("nichts zu melden, wenn der Bedarf überall in die freien Slots passt", () => {
    expect(precheck(input(hours(10, { groupIds: ["7a"], teacherIds: ["LIN"], subjectId: "M" })))).toEqual([]);
  });

  it("Lehrkraft: Bedarf gegen Slots minus Sperrzeiten minus fixierte Stunden – sicher zu viel = Fehler, knapp = Warnung", () => {
    const blocked = new Map<string, number | null>();
    for (let p = 1; p <= 6; p++) blocked.set(`0-${p}`, null); // Montag frei → 24 Slots
    blocked.set("1-6", -3); // Wunsch, keine Sperre
    const fixed = Array.from({ length: 4 }, (_, i) => ({ groupId: "8b", teacherId: "LIN", roomId: null, subjectId: "D", weekday: 1, periodNr: i + 1 }));
    const tight = precheck(input(hours(19, { groupIds: ["7a"], teacherIds: ["LIN"], subjectId: "M" }), { prefs: new Map([["teacher:LIN", blocked]]), fixed }));
    expect(tight).toHaveLength(1);
    expect(tight[0]).toMatchObject({ severity: "warn", kind: "teacher", id: "LIN", demand: 19, free: 20 });
    expect(tight[0]!.message).toBe("Lehrkraft Lindner: 19 Stunden auf 20 freie Slots (4 fixiert, 6 gesperrt) – sehr eng");
    const over = precheck(input(hours(22, { groupIds: ["7a"], teacherIds: ["LIN"], subjectId: "M" }), { prefs: new Map([["teacher:LIN", blocked]]), fixed }));
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ severity: "error", kind: "teacher", demand: 22, free: 20 });
    expect(over[0]!.message).toContain("2 passen sicher nicht");
    // Doppelstunden zählen zwei Slots
    expect(precheck(input(hours(11, { groupIds: ["7a"], teacherIds: ["LIN"], subjectId: "M", length: 2 }), { prefs: new Map([["teacher:LIN", blocked]]), fixed }))[0]).toMatchObject({ severity: "error", demand: 22 });
  });

  it("Gruppe und Raumart: Klasse mit 31 Stunden in 30 Slots; 3 NW-Räume für 100 NW-Stunden; keine Räume der Art", () => {
    const r = precheck(
      input([...hours(31, { groupIds: ["7a"], teacherIds: ["A"], subjectId: "M" }), ...hours(100, { groupIds: ["kurs"], teacherIds: ["B"], subjectId: "BI", roomKind: "nw" })], {
        rooms: [
          { id: "101", kind: "klassenraum", capacity: 30 },
          { id: "NW1", kind: "nw", capacity: 30 },
          { id: "NW2", kind: "nw", capacity: 30 },
          { id: "NW3", kind: "nw", capacity: 30 },
        ],
      }),
    );
    // Fehler zuerst, die engsten voran (Kurs und Lehrkraft B mit 100 Stunden, dann 7a und A mit 31), dann die Warnung zur Raumart
    expect(r.map((f) => [f.severity, f.kind, f.id])).toEqual([
      ["error", "group", "kurs"],
      ["error", "teacher", "B"],
      ["error", "group", "7a"],
      ["error", "teacher", "A"],
      ["warn", "roomKind", "nw"],
    ]);
    expect(r.find((f) => f.id === "7a")!.message).toBe("Klasse Klasse 7a: 31 Stunden zu setzen, aber nur 30 Slots frei – 1 passen sicher nicht");
    expect(r.find((f) => f.kind === "roomKind")!.message).toBe("Raumart nw: 100 Stunden für 3 Räume (90 Slots frei) – 10 Stunden bekommen keinen Fachraum");
    const none = precheck(input(hours(2, { groupIds: ["7a"], teacherIds: ["A"], subjectId: "BI", roomKind: "nw" })));
    expect(none).toEqual([expect.objectContaining({ severity: "warn", kind: "roomKind", free: 0, message: expect.stringContaining("keinen aktiven Raum dieser Art") })]);
  });

  it("Doppelstunden: große Pause zwischen allen Stunden → kein Paar möglich", () => {
    const u = hours(2, { groupIds: ["7a"], teacherIds: ["A"], subjectId: "SP", length: 2 });
    expect(precheck(input(u, { periods: [1, 2, 3, 4], breakAfter: [1, 2, 3] }))).toEqual([expect.objectContaining({ severity: "error", kind: "double", demand: 2 })]);
    expect(precheck(input(u, { periods: [1, 2, 3, 4], breakAfter: [2] }))).toEqual([]);
    expect(precheck(input(u, { periods: [1, 3, 5] }))).toEqual([expect.objectContaining({ kind: "double" })]);
  });
});
