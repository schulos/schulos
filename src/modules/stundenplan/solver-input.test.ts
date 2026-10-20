import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { solve, validate } from "./solver";
import { bandsWithSharedStudents, checkInput, conflictsFrom, solverInputFromDb, unitsFrom } from "./solver-input";
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
      hours,
      doubleLessons,
      roomId: null,
      groups: groups.map((g) => ({ id: g, name: g })),
      teachers: [{ id: "t", code: "BRA", name: "Jana Brandt" }],
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

  it("SP2-02: Band = eine Einheit je Stunde mit einem Teil je Mitglied (eigenes Fach, eigene Lehrkraft, eigener Raumwunsch)", () => {
    const a = (id: string, group: string, subjectId = "REL", teachers = [{ id: "t1", code: "RIC", name: "R" }], roomId: string | null = null) => ({
      id,
      subjectId,
      subjectName: subjectId === "REL" ? "Religion" : "Philosophie",
      hours: 2,
      doubleLessons: 1,
      roomId,
      groups: [{ id: group, name: group }],
      teachers,
    });
    const info = { roomKindOf: new Map([["PP", "mu"]]), homeRoomOf: new Map([["7a", "106"], ["7b", "107"]]), sizeOf: new Map([["7a", 28], ["7b", 27]]), classIds: new Set(["7a", "7b"]) };
    const band = { id: "b", name: "Reli/PP 7", hours: 2, doubleLessons: 1, memberIds: ["m2", "m1", "m3"] };
    const units = unitsFrom(
      {
        assignments: [a("m1", "7a"), a("m3", "7a", "PP", [{ id: "t2", code: "NEU", name: "N" }], "MU1"), a("m2", "7b"), a("x", "7b", "D", [{ id: "t3", code: "DRE", name: "D" }])],
        bands: [band],
      },
      info,
    );
    // Band: eine Doppelstunde (ids nach dem Band), Mitglieder nach Gruppenname sortiert; Deutsch 7b bleibt ein eigener Lehrauftrag
    expect(units.map((u) => [u.id, u.length])).toEqual([
      ["b#d0", 2],
      ["x#d0", 2],
    ]);
    const u = units[0]!;
    expect(u).toMatchObject({ assignmentId: "m1", groupIds: ["7a", "7b"], teacherIds: ["t1", "t2"], subjectId: "REL", roomKind: "mu", homeRoomId: null, size: 55 });
    expect(u.label).toBe("Reli/PP 7: 7a Religion (RIC) + 7a Philosophie (NEU) + 7b Religion (RIC)");
    expect(u.parts).toEqual([
      { assignmentId: "m1", groupIds: ["7a"], teacherIds: ["t1"], subjectId: "REL", roomId: null, roomKind: null, homeRoomId: "106", size: 28 },
      { assignmentId: "m3", groupIds: ["7a"], teacherIds: ["t2"], subjectId: "PP", roomId: "MU1", roomKind: "mu", homeRoomId: "106", size: 28 },
      { assignmentId: "m2", groupIds: ["7b"], teacherIds: ["t1"], subjectId: "REL", roomId: null, roomKind: null, homeRoomId: "107", size: 27 },
    ]);

    // Teamteaching in einem Mitglied: ein Teil je Lehrkraft; fixierte Stunden zählen je Mitglied – geplant wird, was dem am weitesten
    // fixierten Mitglied fehlt (kein Mitglied bekommt mehr als das Soll)
    const team = unitsFrom(
      {
        assignments: [a("m1", "7a", "REL", [{ id: "t1", code: "RIC", name: "R" }, { id: "t4", code: "VIE", name: "V" }]), a("m2", "7b")],
        bands: [{ ...band, hours: 3, doubleLessons: 0, memberIds: ["m1", "m2"] }],
      },
      { ...info, fixedHours: new Map([["m1", 1], ["m2", 2]]) },
    );
    expect(team.map((u) => u.id)).toEqual(["b#e0"]);
    expect(team[0]!.parts.map((p) => [p.groupIds[0], p.teacherIds[0], p.size])).toEqual([
      ["7a", "t1", 14],
      ["7a", "t4", 14],
      ["7b", "t1", 27],
    ]);
    expect(team[0]!.teacherIds).toEqual(["t1", "t4"]);

    // Band mit einem Mitglied: wie ein Lehrauftrag, aber mit der Band-id; leeres Band und Mitglied ohne Gruppe ergeben nichts
    const single = unitsFrom({ assignments: [a("m1", "7a"), { ...a("m9", "7a"), groups: [] }], bands: [{ ...band, memberIds: ["m1", "m9"] }, { ...band, id: "leer", memberIds: [] }] }, info);
    expect(single.map((u) => [u.id, u.label, u.parts.length])).toEqual([["b#d0", "Reli/PP 7: 7a Religion (RIC)", 1]]);
    expect(single[0]!.homeRoomId).toBe("106");
  });

  it("SP2-02 (Q-SP2-6): Band-Mitglieder mit gemeinsamen Schüler:innen – Warnung in der Vorprüfung, Paare für die Diagnose", () => {
    const assignments = [
      { id: "m1", groups: [{ id: "k1", name: "Q1 Englisch GK1" }] },
      { id: "m2", groups: [{ id: "k2", name: "Q1 Deutsch GK1" }] },
      { id: "m3", groups: [{ id: "k3", name: "Q1 Biologie GK1" }] },
    ];
    const conflicts = conflictsFrom([
      { groupId: "k1", userId: "s1" },
      { groupId: "k2", userId: "s1" },
      { groupId: "k3", userId: "s2" },
    ]);
    const bands = [
      { name: "Schiene A", memberIds: ["m1", "m2", "m3"] },
      { name: "Schiene B", memberIds: ["m1", "m3"] },
      { name: "leer", memberIds: [] },
    ];
    expect(bandsWithSharedStudents(bands, assignments, conflicts).map((b) => [b.name, b.pairs])).toEqual([["Schiene A", [["k1", "k2"]]]]);
    const warn = checkInput({
      periods: 8,
      assignments,
      activeRooms: 1,
      groupsWithMembers: new Set(["k1", "k2", "k3"]),
      groupKind: new Map([["k1", "kurs"], ["k2", "kurs"], ["k3", "kurs"]]),
      groupName: new Map(),
      replaceable: [],
      bands,
      conflicts,
    }).warnings;
    expect(warn).toEqual([expect.stringMatching(/^1 Band mit gemeinsamen Schüler:innen in mehreren Mitgliedern \(Schiene A\)/)]);
    expect(checkInput({ periods: 8, assignments, activeRooms: 1, groupsWithMembers: new Set(["k1", "k2", "k3"]), groupKind: new Map(), groupName: new Map(), replaceable: [], bands }).warnings).toEqual([]);
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
    // keine Warnungen: die Kurse des Demo-Bands haben getrennte Schüler:innen (Q-SP2-6)
    expect(input.check).toEqual({ errors: {}, warnings: [] });
    // SP2-02: das Demo-Band „Q1 GK-Schiene A“ ist eine Einheit je Stunde mit drei Teilen (Englisch, Deutsch, Biologie – drei Lehrkräfte)
    const band = input.units.filter((u) => u.id.startsWith("band-q1-gk-a#"));
    expect(band).toHaveLength(3);
    expect(band[0]!.parts.map((p) => p.subjectId).sort()).toEqual(["BI", "D", "E"]);
    expect(new Set(band[0]!.teacherIds).size).toBe(3);
    expect(band[0]!.groupIds.sort()).toEqual(["g-q1-bi-gk1", "g-q1-d-gk1", "g-q1-e-gk1"]);
    expect(input.units.filter((u) => u.parts.length > 1)).toHaveLength(3);
    const t0 = performance.now();
    const r = solve(input);
    const ms = performance.now() - t0;
    expect(r.unplaced).toEqual([]);
    expect(validate(input, r.placements)).toEqual([]);
    expect(r.breakdown.noRoom).toBe(0);
    // Band-Stunden: drei Räume je Platzierung (Biologie im NW-Raum), die drei Kurse liegen zur selben Zeit
    for (const p of r.placements.filter((x) => x.unitId.startsWith("band-q1-gk-a#"))) {
      expect(p.roomIds).toHaveLength(3);
      expect(new Set(p.roomIds).size).toBe(3);
    }
    // Demo (Stand P2b-22): 0 Hohlstunden in Klassen, kein Fach mehrfach am Tag, alle Raumwünsche erfüllt
    expect(r.breakdown.classGap).toBeLessThanOrEqual(2 * 10);
    expect(r.breakdown.subjectTwice).toBeLessThanOrEqual(2 * 8);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});
