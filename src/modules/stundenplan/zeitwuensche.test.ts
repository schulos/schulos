import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { assignmentPlacement, openAssignments, placementGrid } from "./setzhilfe";
import { createAssignment, planningYear } from "./verteilung";
import { allPrefs, blockedReasons, parsePref, prefKey, prefLabel, prefsOf, savePrefs } from "./zeitwuensche";

describe("parsePref / prefLabel / blockedReasons", () => {
  it("liest Formularwerte", () => {
    expect([parsePref("x"), parsePref("-3"), parsePref("0"), parsePref(""), parsePref("3"), parsePref("4"), parsePref("1.5")]).toEqual([null, -3, 0, 0, 3, undefined, undefined]);
    expect([prefLabel(null), prefLabel(2), prefLabel(-1), prefLabel(0)]).toEqual(["gesperrt", "+2", "−1", "egal"]);
  });

  it("nennt gesperrte Ziele im Slot", () => {
    const prefs = new Map([
      ["teacher:t1", new Map([[prefKey(0, 1), null], [prefKey(0, 2), -3]])],
      ["room:NW1", new Map([[prefKey(0, 1), null]])],
    ]);
    const targets = [
      { kind: "teacher" as const, id: "t1", label: "BRA" },
      { kind: "room" as const, id: "NW1", label: "Raum NW1" },
      { kind: "group" as const, id: null, label: "–" },
    ];
    expect(blockedReasons(prefs, targets, 0, 1)).toEqual(["BRA: Zeit gesperrt", "Raum NW1: Zeit gesperrt"]);
    expect(blockedReasons(prefs, targets, 0, 2)).toEqual([]);
  });
});

describe("Zeitwünsche (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("speichert ein Raster (neutral nicht gespeichert), ersetzt es beim nächsten Speichern, prüft Ziel", async () => {
    await expect(savePrefs(h.db, "u-admin", "teacher", "u-lea.schaefer", new Map())).rejects.toBeInstanceOf(ValidationError);
    await expect(savePrefs(h.db, "u-admin", "x", "u-jana.brandt", new Map())).rejects.toBeInstanceOf(ValidationError);
    expect(
      await savePrefs(h.db, "u-admin", "teacher", "u-jana.brandt", new Map([[prefKey(0, 1), null], [prefKey(4, 6), -2], [prefKey(2, 3), 0]])),
    ).toBe(2);
    expect([...(await prefsOf(h.db, "teacher", "u-jana.brandt"))]).toEqual(expect.arrayContaining([[prefKey(0, 1), null], [prefKey(4, 6), -2]]));
    await savePrefs(h.db, "u-admin", "teacher", "u-jana.brandt", new Map([[prefKey(1, 1), 3]]));
    expect([...(await prefsOf(h.db, "teacher", "u-jana.brandt"))]).toEqual([[prefKey(1, 1), 3]]);
    expect((await allPrefs(h.db)).get("teacher:u-jana.brandt")?.get(prefKey(1, 1))).toBe(3);
  });

  it("Setzhilfe: gesperrte Zeit der Klasse ist kein freies Feld, mit Grund", async () => {
    const year = (await planningYear(h.db))!;
    await createAssignment(h.db, "u-admin", { schoolYearId: year.id, groupId: "g-6b", subjectId: "F", hours: 2, teacherIds: ["u-sophie.wagner"], doubleLessons: 0, roomId: null, note: null });
    const a = (await openAssignments(h.db, "g-6b", today)).find((x) => x.subjectId === "F")!;
    let grid = placementGrid({ ...(await assignmentPlacement(h.db, a, today)), unitIds: [], weekdays: [0, 1, 2, 3, 4], periods: [1, 2, 3, 4, 5, 6, 7, 8] });
    const free = [...grid.entries()].find(([, c]) => c.state === "free")![0];
    const [wd, p] = free.split("-").map(Number);
    await savePrefs(h.db, "u-admin", "group", "g-6b", new Map([[prefKey(wd!, p!), null]]));
    grid = placementGrid({ ...(await assignmentPlacement(h.db, a, today)), unitIds: [], weekdays: [0, 1, 2, 3, 4], periods: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(grid.get(free)).toEqual({ state: "blocked", reasons: ["Klasse 6b: Zeit gesperrt"] });
  });
});
