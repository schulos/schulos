import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { solve, validate } from "./solver";
import { checkInput, conflictsFrom, solverInputFromDb, unitsFrom } from "./solver-input";
import { planningYear } from "./verteilung";

describe("conflictsFrom / unitsFrom", () => {
  it("gemeinsame Mitglieder → Konflikt in beide Richtungen", () => {
    const c = conflictsFrom([
      { groupId: "7a", userId: "s1" },
      { groupId: "wp", userId: "s1" },
      { groupId: "7b", userId: "s2" },
    ]);
    expect([...(c.get("7a") ?? [])]).toEqual(["wp"]);
    expect([...(c.get("wp") ?? [])]).toEqual(["7a"]);
    expect(c.has("7b")).toBe(false);
  });

  it("Doppelstunden als Block, fixierte Stunden abgezogen, Stammraum nur für eine Klasse", () => {
    const a = (id: string, groups: string[], hours: number, doubleLessons: number) => ({
      id,
      subjectId: "D",
      subjectName: "Deutsch",
      color: "#000",
      hours,
      doubleLessons,
      roomId: null,
      note: null,
      groups: groups.map((g) => ({ id: g, name: g })),
      teachers: [{ id: "t", code: "BRA", name: "Jana Brandt" }],
      planned: 0,
      otherTeacher: false,
    });
    const units = unitsFrom(
      { assignments: [a("x", ["7a"], 5, 2), a("y", ["7a", "7b"], 2, 0)] },
      {
        roomKindOf: new Map(),
        homeRoomOf: new Map([["7a", "106"]]),
        sizeOf: new Map([
          ["7a", 28],
          ["7b", 27],
        ]),
        classIds: new Set(["7a", "7b"]),
        fixedHours: new Map([["x", 1]]),
      },
    );
    expect(units.filter((u) => u.assignmentId === "x").map((u) => u.length)).toEqual([2, 2]);
    const y = units.filter((u) => u.assignmentId === "y");
    expect(y).toHaveLength(2);
    expect(y[0]).toMatchObject({ groupIds: ["7a", "7b"], homeRoomId: null, size: 55, label: "7a + 7b Deutsch (BRA)" });
    expect(units[0]!.homeRoomId).toBe("106");
    // bandfähig (Q-SP-13): genau ein Teil je Einheit mit denselben Angaben wie der Lehrauftrag
    expect(y[0]!.parts).toEqual([{ assignmentId: "y", groupIds: ["7a", "7b"], teacherIds: ["t"], subjectId: "D", roomId: null, roomKind: null, homeRoomId: null, size: 55 }]);
    expect(units[0]!.parts[0]).toMatchObject({ assignmentId: "x", homeRoomId: "106", size: 28 });

    // SP-G-02: zwei Lehrkräfte → ein Teil je Lehrkraft (geteilte Klasse: eigener Raum, halbe Gruppe), die Einheit bleibt eine Kopplung
    const split = unitsFrom(
      { assignments: [{ ...a("sp", ["7a"], 2, 1), subjectId: "SP", teachers: [{ id: "t1", code: "BAU", name: "B" }, { id: "t2", code: "MEY", name: "M" }] }] },
      { roomKindOf: new Map([["SP", "sport"]]), homeRoomOf: new Map([["7a", "106"]]), sizeOf: new Map([["7a", 27]]), classIds: new Set(["7a"]) },
    );
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({ length: 2, groupIds: ["7a"], teacherIds: ["t1", "t2"], size: 27, roomKind: "sport", label: "7a Deutsch (BAU + MEY)" });
    expect(split[0]!.parts).toEqual([
      { assignmentId: "sp", groupIds: ["7a"], teacherIds: ["t1"], subjectId: "SP", roomId: null, roomKind: "sport", homeRoomId: "106", size: 14 },
      { assignmentId: "sp", groupIds: ["7a"], teacherIds: ["t2"], subjectId: "SP", roomId: null, roomKind: "sport", homeRoomId: "106", size: 14 },
    ]);
  });

  it("checkInput: Fehler ohne Zeitraster/Lehraufträge/Räume; Warnungen für Kurse ohne Mitglieder (SP-G-13) und A/B-Stunden", () => {
    const groupKind = new Map([
      ["7a", "klasse"],
      ["wp1", "wahlpflicht"],
      ["q1-m", "kurs"],
    ]);
    const groupName = new Map([
      ["7a", "Klasse 7a"],
      ["wp1", "WP Technik"],
      ["q1-m", "Q1 Mathe GK"],
    ]);
    const assignments = [{ id: "a", groups: [{ id: "7a", name: "7a" }] }, { id: "b", groups: [{ id: "wp1", name: "WP" }] }, { id: "c", groups: [{ id: "q1-m", name: "Q1" }] }, { id: "d", groups: [] }];
    const empty = checkInput({ periods: 0, assignments: [{ id: "d", groups: [] }], activeRooms: 0, groupsWithMembers: new Set(), groupKind, groupName, replaceable: [] });
    expect(Object.keys(empty.errors).sort()).toEqual(["assignments", "periods", "rooms"]);
    expect(empty.warnings).toEqual([]);
    const ok = checkInput({ periods: 8, assignments, activeRooms: 3, groupsWithMembers: new Set(["wp1"]), groupKind, groupName, replaceable: [{ week: "all", groupName: "7a", subjectName: "D" }] });
    expect(ok.errors).toEqual({});
    // Klasse ohne Mitglieder ist keine Warnung (Klassen kollidieren nicht untereinander), der leere Kurs schon
    expect(ok.warnings).toEqual([expect.stringMatching(/^1 Kurs mit Lehrauftrag ohne Mitglieder \(Q1 Mathe GK\)/)]);
    const ab = checkInput({
      periods: 8,
      assignments,
      activeRooms: 3,
      groupsWithMembers: new Set(["wp1", "q1-m"]),
      groupKind,
      groupName,
      replaceable: [
        { week: "A", groupName: "7a", subjectName: "Kunst" },
        { week: "B", groupName: "7a", subjectName: "Kunst" },
        { week: "A", groupName: "7a", subjectName: "Musik" },
      ],
    });
    expect(ab.warnings).toEqual([expect.stringMatching(/^3 A\/B-Wochen-Stunden mit Lehrauftrag sind nicht fixiert \(7a Kunst, 7a Musik\)/)]);
  });
});

describe("Solver auf der Demo-Schule", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("setzt alle Lehraufträge kollisionsfrei, Kurse eines Jahrgangs nie parallel, wenige Hohlstunden", async () => {
    const year = (await planningYear(h.db))!;
    const input = await solverInputFromDb(h.db, year, "2026-10-05", { seed: 1 });
    expect(input.units.length).toBeGreaterThan(300);
    // Demo-Raster: große Pausen nach der 2., 4. und 6. Stunde; Eingabe ohne Hinweise
    expect(input.breakAfter).toEqual([2, 4, 6]);
    expect(input.check).toEqual({ errors: {}, warnings: [] });
    const t0 = performance.now();
    const r = solve(input);
    const ms = performance.now() - t0;
    expect(r.unplaced).toEqual([]);
    expect(validate(input, r.placements)).toEqual([]);
    expect(r.breakdown.noRoom).toBe(0);
    // Demo (Stand P2b-22): 0 Hohlstunden in Klassen, kein Fach mehrfach am Tag, alle Raumwünsche erfüllt
    expect(r.breakdown.classGap).toBeLessThanOrEqual(2 * 10);
    expect(r.breakdown.subjectTwice).toBeLessThanOrEqual(2 * 8);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});
