import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAssignment, createBand, deleteBand, planningYear } from "./verteilung";
import {
  assignmentPlacement,
  assignmentRows,
  moveGridInput,
  moveLesson,
  movePlacement,
  openAssignments,
  placeAssignment,
  placementCell,
  placementGrid,
  type GridInput,
  type GridLesson,
} from "./setzhilfe";

const year = { validFrom: "2026-08-01", validUntil: "2027-07-31" };
const lesson = (id: string, o: Partial<GridLesson>): GridLesson => ({
  id,
  couplingId: null,
  groupId: "7a",
  groupName: "7a",
  subjectId: "M",
  subjectName: "Mathematik",
  teacherId: "t1",
  teacherCode: "AAA",
  roomId: "101",
  weekday: 0,
  periodNr: 1,
  week: "all",
  ...year,
  ...o,
});
const roomList = [
  { id: "101", kind: "klassenraum", active: true },
  { id: "102", kind: "klassenraum", active: true },
  { id: "NW1", kind: "nw", active: true },
];
const input = (o: Partial<GridInput>): GridInput => ({
  rows: [{ groupId: "7b", subjectId: "D", teacherId: "t2", roomId: "102", week: "all", ...year }],
  unitIds: [],
  lessons: [],
  rooms: roomList,
  weekdays: [0],
  periods: [1, 2],
  ...o,
});

describe("placementCell", () => {
  it("nennt die Gründe: Lehrkraft, Gruppe", () => {
    const lessons = [lesson("x", { groupId: "7a", teacherId: "t2", teacherCode: "BBB" }), lesson("y", { groupId: "7b", groupName: "7b", subjectName: "Deutsch", teacherId: "t3", roomId: "103" })];
    const cell = placementCell(input({ lessons }), 0, 1);
    expect(cell).toEqual({ state: "blocked", reasons: ["BBB unterrichtet 7a", "7b hat Deutsch"] });
    expect(placementCell(input({ lessons }), 0, 2)).toEqual({ state: "free", rooms: ["102"], roomNote: null });
  });

  it("A- und B-Woche und Gültigkeit zählen", () => {
    const lessons = [lesson("x", { teacherId: "t2", week: "A" })];
    expect(placementCell(input({ lessons, rows: [{ groupId: "7b", subjectId: "D", teacherId: "t2", roomId: null, week: "B", ...year }] }), 0, 1).state).toBe("free");
    expect(placementCell(input({ lessons: [lesson("x", { teacherId: "t2", validUntil: "2026-07-31", validFrom: "2026-02-01" })] }), 0, 1).state).toBe("free");
  });

  it("belegter Wunschraum: freier Raum derselben Art, sonst ohne Raum", () => {
    expect(placementCell(input({ lessons: [lesson("x", { roomId: "102" })] }), 0, 1)).toEqual({ state: "free", rooms: ["101"], roomNote: "Raum 102 belegt → 101" });
    const nw = input({ rows: [{ groupId: "7b", subjectId: "BI", teacherId: "t2", roomId: "NW1", week: "all", ...year }], lessons: [lesson("x", { roomId: "NW1" })] });
    expect(placementCell(nw, 0, 1)).toEqual({ state: "free", rooms: [null], roomNote: "Raum NW1 belegt → ohne Raum" });
  });

  it("Kopplung: alle Teile müssen frei sein, gemeinsamer Raum bleibt gemeinsam", () => {
    const rows = assignmentRows({ groups: [{ id: "7a", name: "7a" }, { id: "7b", name: "7b" }], teachers: [{ id: "t9", code: "ZZZ", name: "Z" }], subjectId: "REL" }, "102", year);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.subjectId === "REL")).toBe(true);
    expect(placementCell(input({ rows, lessons: [lesson("x", { periodNr: 2 })] }), 0, 1)).toEqual({ state: "free", rooms: ["102", "102"], roomNote: null });
    expect(placementCell(input({ rows, lessons: [lesson("x", {})] }), 0, 1)).toMatchObject({ state: "blocked", reasons: ["7a hat Mathematik"] });
  });

  it("SP2-02 Band: Teile mit verschiedenen Lehrkräften bekommen verschiedene Räume, gleiche Lehrkraft denselben; Fachsperre eines Teils sperrt", () => {
    // Religion/Philosophie 7a+7b: RIC (REL, 7a und 7b) und NEU (PP, 7a) – beide wünschen den Stammraum 101
    const rows = [
      { groupId: "7a", subjectId: "REL", teacherId: "t1", roomId: "101", week: "all" as const, ...year },
      { groupId: "7a", subjectId: "PP", teacherId: "t2", roomId: "101", week: "all" as const, ...year },
      { groupId: "7b", subjectId: "REL", teacherId: "t1", roomId: "101", week: "all" as const, ...year },
    ];
    expect(placementCell(input({ rows }), 0, 1)).toEqual({ state: "free", rooms: ["101", "102", "101"], roomNote: "Raum 101 belegt → 102" });
    // Teamteaching im selben Raum (gleiche Gruppe, gleicher Wunschraum, zwei Lehrkräfte) bleibt ein Raum
    const team = [
      { groupId: "7a", subjectId: "D", teacherId: "t1", roomId: "101", week: "all" as const, ...year },
      { groupId: "7a", subjectId: "D", teacherId: "t2", roomId: "101", week: "all" as const, ...year },
    ];
    expect(placementCell(input({ rows: team }), 0, 1)).toEqual({ state: "free", rooms: ["101", "101"], roomNote: null });
    // ein Teil gesperrt (Zeitwunsch des Fachs) → der ganze Slot ist gesperrt
    const blocked = (weekday: number, periodNr: number) => (periodNr === 2 ? ["Philosophie: Zeit gesperrt"] : []);
    expect(placementCell(input({ rows, blocked }), 0, 2)).toEqual({ state: "blocked", reasons: ["Philosophie: Zeit gesperrt"] });
    // eine Lehrkraft eines Teils ist belegt → Grund
    expect(placementCell(input({ rows, lessons: [lesson("x", { groupId: "8a", groupName: "8a", teacherId: "t2", teacherCode: "NEU" })] }), 0, 1)).toEqual({ state: "blocked", reasons: ["NEU unterrichtet 8a"] });
  });

  it("Verschieben: eigener Slot, Tauschen mit der Stunde der Gruppe, Tausch scheitert an Lehrkraft", () => {
    const own = lesson("own", { groupId: "7b", groupName: "7b", subjectName: "Deutsch", teacherId: "t2", teacherCode: "BBB", roomId: "102" });
    const other = lesson("oth", { groupId: "7b", groupName: "7b", periodNr: 2, teacherId: "t1", teacherCode: "AAA", roomId: "102" });
    const base = input({ rows: [own], unitIds: ["own"], current: { weekday: 0, periodNr: 1 }, swapGroupId: "7b", lessons: [own, other] });
    const grid = placementGrid(base);
    expect(grid.get("0-1")).toEqual({ state: "current" });
    expect(grid.get("0-2")).toEqual({ state: "swap", partnerIds: ["oth"], label: "Mathematik (AAA)" });
    // AAA hat in der 1. Stunde schon 7a → Tausch geht nicht
    const busy = lesson("busy", { groupId: "7a", teacherId: "t1", roomId: "101" });
    expect(placementCell({ ...base, lessons: [own, other, busy] }, 0, 2)).toEqual({ state: "blocked", reasons: ["7b hat Mathematik", "Tausch: AAA unterrichtet 7a"] });
    // SP2-05: Sperrzeit des Partners am bisherigen Slot (AAA ist Mo 1. gesperrt) → Tausch geht nicht
    const blockedFor = (ls: { teacherCode: string | null }[], weekday: number, periodNr: number) => (weekday === 0 && periodNr === 1 && ls.some((l) => l.teacherCode === "AAA") ? ["AAA: Zeit gesperrt"] : []);
    expect(placementCell({ ...base, blockedFor }, 0, 2)).toEqual({ state: "blocked", reasons: ["7b hat Mathematik", "Tausch: AAA: Zeit gesperrt"] });
    // die eigene Stunde am Ziel-Slot prüft weiter `blocked`
    expect(placementCell({ ...base, blockedFor: () => [] }, 0, 2)).toEqual({ state: "swap", partnerIds: ["oth"], label: "Mathematik (AAA)" });
  });
});

describe("Setzhilfe (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  let assignmentId: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    const y = (await planningYear(h.db))!;
    assignmentId = await createAssignment(h.db, "u-admin", {
      schoolYearId: y.id,
      groupId: "g-7b",
      subjectId: "F",
      hours: 2,
      teacherIds: ["u-jana.brandt"],
      doubleLessons: 0,
      roomId: null,
      note: null,
    });
  });
  afterAll(() => h.close());

  async function errorOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0]!;
      throw err;
    }
    throw new Error("keine ValidationError");
  }

  it("setzt offene Stunden in freie Felder, lehnt belegte ab", async () => {
    const open = await openAssignments(h.db, "g-7b", today);
    expect(open.map((a) => [a.id, a.open])).toEqual([[assignmentId, 2]]);
    const pl = await assignmentPlacement(h.db, open[0]!, today);
    expect(pl.rows).toEqual([{ groupId: "g-7b", subjectId: "F", teacherId: "u-jana.brandt", roomId: expect.any(String), week: "all", ...year }]);
    const grid = placementGrid({ ...pl, unitIds: [], weekdays: [0, 1, 2, 3, 4], periods: [1, 2, 3, 4, 5, 6, 7, 8] });
    const free = [...grid].filter(([, c]) => c.state === "free").map(([k]) => k.split("-").map(Number) as [number, number]);
    const blocked = [...grid].find(([, c]) => c.state === "blocked")!;
    expect(free.length).toBeGreaterThan(1);
    expect(blocked[1]).toMatchObject({ reasons: expect.arrayContaining([expect.stringMatching(/^Klasse 7b hat /)]) });

    const [bd, bp] = blocked[0].split("-").map(Number);
    expect(await errorOf(placeAssignment(h.db, "u-admin", assignmentId, "g-7b", bd!, bp!, today))).toMatch(/Klasse 7b hat /);
    await placeAssignment(h.db, "u-admin", assignmentId, "g-7b", free[0]![0], free[0]![1], today);
    expect((await openAssignments(h.db, "g-7b", today))[0]!.open).toBe(1);
    await placeAssignment(h.db, "u-admin", assignmentId, "g-7b", free[1]![0], free[1]![1], today);
    expect(await openAssignments(h.db, "g-7b", today)).toEqual([]);
    expect(await errorOf(placeAssignment(h.db, "u-admin", assignmentId, "g-7b", free[2]![0], free[2]![1], today))).toMatch(/keine Stunde mehr offen/);
  });

  it("verschiebt in freie Felder und tauscht mit Stunden der Klasse", async () => {
    // SP3-05: Planung vor Schuljahresbeginn (ohne Vergangenheitsbezug) ändert in place; den Split im laufenden Plan prüft sofortkorrektur.test.ts
    const beforeYear = { today: "2026-07-31" };
    const [placed] = await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.subjectId, "F"), eq(timetableLessons.groupId, "g-7b")));
    const m = (await movePlacement(h.db, placed!.id))!;
    const grid = placementGrid(moveGridInput(m, "g-7b", [0, 1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8]));
    expect(grid.get(`${placed!.weekday}-${placed!.periodNr}`)).toEqual({ state: "current" });

    const free = [...grid].find(([, c]) => c.state === "free");
    if (free) {
      const [d, p] = free[0].split("-").map(Number);
      expect(await moveLesson(h.db, "u-admin", placed!.id, "g-7b", d!, p!, undefined, beforeYear)).toBe("moved");
      const [after] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, placed!.id));
      expect([after!.weekday, after!.periodNr]).toEqual([d, p]);
    }

    const m2 = (await movePlacement(h.db, placed!.id))!;
    const from = { weekday: m2.unit[0]!.weekday, periodNr: m2.unit[0]!.periodNr };
    const swap = [...placementGrid(moveGridInput(m2, "g-7b", [0, 1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8]))].find(([, c]) => c.state === "swap");
    expect(swap).toBeDefined();
    const [d, p] = swap![0].split("-").map(Number);
    const partnerIds = swap![1].state === "swap" ? swap![1].partnerIds : [];
    expect(await moveLesson(h.db, "u-admin", placed!.id, "g-7b", d!, p!, undefined, beforeYear)).toBe("swapped");
    const [moved] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, placed!.id));
    const [partner] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, partnerIds[0]!));
    expect([moved!.weekday, moved!.periodNr]).toEqual([d, p]);
    expect([partner!.weekday, partner!.periodNr]).toEqual([from.weekday, from.periodNr]);
    const log = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.lesson.swap"));
    expect(log).toHaveLength(1);
  });

  it("SP2-02 Band: offen je Band, Setzen legt eine Kopplung mit allen Mitgliedern an (Fach und Raum je Teil), Verschieben bewegt das Band", async () => {
    const y = (await planningYear(h.db))!;
    // Band „Reli/Philo 7“: Religion 7b (Jana Brandt) + Politik 7a (Frank Schulte) – verschiedene Fächer und Lehrkräfte
    const bandId = await createBand(h.db, "u-admin", { schoolYearId: y.id, name: "Reli/Philo 7", hours: 1, doubleLessons: 0 });
    const rel = await createAssignment(h.db, "u-admin", { schoolYearId: y.id, groupId: "g-7b", subjectId: "REL", hours: 1, teacherIds: ["u-jana.brandt"], doubleLessons: 0, roomId: null, note: null, bandId });
    const pp = await createAssignment(h.db, "u-admin", { schoolYearId: y.id, groupId: "g-7a", subjectId: "PK", hours: 1, teacherIds: ["u-frank.schulte"], doubleLessons: 0, roomId: "201", note: null, bandId });
    const open7b = await openAssignments(h.db, "g-7b", today);
    expect(open7b.map((a) => [a.id, a.open, a.band?.name])).toEqual([[rel, 1, "Reli/Philo 7"]]);
    expect(open7b[0]!.band!.members.map((m) => m.id).sort()).toEqual([rel, pp].sort());
    // beide Klassen sehen das Band offen
    expect((await openAssignments(h.db, "g-7a", today)).map((a) => a.id)).toEqual([pp]);

    const pl = await assignmentPlacement(h.db, open7b[0]!, today);
    expect(pl.rows.map((r) => [r.groupId, r.subjectId, r.teacherId, r.roomId])).toEqual([
      ["g-7a", "PK", "u-frank.schulte", "201"],
      ["g-7b", "REL", "u-jana.brandt", expect.any(String)],
    ]);
    const grid = placementGrid({ ...pl, unitIds: [], weekdays: [0, 1, 2, 3, 4], periods: [1, 2, 3, 4, 5, 6, 7, 8] });
    const free = [...grid].find(([, c]) => c.state === "free")!;
    const [d, p] = free[0].split("-").map(Number) as [number, number];
    await placeAssignment(h.db, "u-admin", rel, "g-7b", d, p, today);
    const lessons = await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.weekday, d), eq(timetableLessons.periodNr, p), inArray(timetableLessons.subjectId, ["REL", "PK"])));
    expect(lessons).toHaveLength(2);
    expect(lessons[0]!.couplingId).not.toBeNull();
    expect(lessons[0]!.couplingId).toBe(lessons[1]!.couplingId);
    expect(lessons.map((l) => [l.groupId, l.subjectId, l.teacherId]).sort()).toEqual([
      ["g-7a", "PK", "u-frank.schulte"],
      ["g-7b", "REL", "u-jana.brandt"],
    ]);
    expect(lessons.find((l) => l.subjectId === "PK")!.roomId).toBe("201");
    // Band vollständig: in keiner der beiden Klassen mehr offen
    expect(await openAssignments(h.db, "g-7b", today)).toEqual([]);
    expect(await openAssignments(h.db, "g-7a", today)).toEqual([]);
    expect(await errorOf(placeAssignment(h.db, "u-admin", rel, "g-7b", d, p, today))).toMatch(/keine Stunde mehr offen/);

    // Verschieben: die Einheit sind beide Teile; danach liegen beide im neuen Slot
    const relLesson = lessons.find((l) => l.subjectId === "REL")!;
    const m = (await movePlacement(h.db, relLesson.id))!;
    expect(m.unit.map((u) => u.subjectId).sort()).toEqual(["PK", "REL"]);
    const moveGrid = placementGrid(moveGridInput(m, "g-7b", [0, 1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8]));
    const target = [...moveGrid].find(([, c]) => c.state === "free");
    expect(target).toBeDefined();
    const [td, tp] = target![0].split("-").map(Number) as [number, number];
    expect(await moveLesson(h.db, "u-admin", relLesson.id, "g-7b", td, tp)).toBe("moved");
    const moved = await h.db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, relLesson.couplingId!));
    expect(moved.map((l) => [l.weekday, l.periodNr])).toEqual([
      [td, tp],
      [td, tp],
    ]);
    // aufräumen
    await h.db.delete(timetableLessons).where(eq(timetableLessons.couplingId, relLesson.couplingId!));
    await deleteBand(h.db, "u-admin", bandId);
  });
});
