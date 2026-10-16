import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { solve, validate } from "./solver";
import { conflictsFrom, solverInputFromDb, unitsFrom } from "./solver-input";
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
