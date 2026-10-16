import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { createAbsence } from "./abwesenheit";
import { saveSubstitution } from "./vertretung";
import { scoreCandidates, substitutionStats, suggestSubstitutes, WEIGHTS, type ScoreInput } from "./vorschlaege";

describe("scoreCandidates", () => {
  const base = (over: Partial<ScoreInput> = {}): ScoreInput => ({
    lesson: { groupId: "7b", subjectId: "M", periodNr: 3 },
    free: [
      { id: "a", code: "AAA", name: "A" },
      { id: "b", code: "BBB", name: "B" },
      { id: "c", code: "CCC", name: "C" },
      { id: "d", code: "DDD", name: "D" },
    ],
    dayPeriods: new Map([
      ["a", [1, 2, 5]],
      ["b", [1, 2]],
      ["c", [2, 4]],
    ]),
    released: new Set(),
    teachesGroup: new Map([["b", new Set(["7b"])]]),
    teachesSubject: new Map([["c", new Set(["M"])]]),
    countYear: new Map(),
    countToday: new Map(),
    ...over,
  });

  it("Punkte mit Begründung: Klasse, Fach, Hohl-/Randstunde, sonst frei", () => {
    const r = scoreCandidates(base());
    expect(r.map((c) => `${c.code}:${c.score}`)).toEqual([`CCC:${15 + 10}`, `AAA:${10}`, `BBB:${20 - 10}`, `DDD:${WEIGHTS.dayOff}`]); // Gleichstand: Kürzel
    expect(r[0]!.reasons.map((x) => x.label)).toEqual(["unterrichtet das Fach", "Hohlstunde"]);
  });

  it("Freisetzung zählt viel, viele Vertretungen und zweimal heute senken", () => {
    const r = scoreCandidates(base({ released: new Set(["d"]), countYear: new Map([["c", 10]]), countToday: new Map([["c", 2]]) }));
    expect(r[0]!.code).toBe("DDD");
    expect(r[0]!.reasons[0]).toEqual({ label: "frei durch Freisetzung", points: 30 });
    const c = r.find((x) => x.code === "CCC")!;
    expect(c.reasons.map((x) => x.label)).toEqual(["unterrichtet das Fach", "Hohlstunde", "10 Vertretungen im Schuljahr", "heute schon 2× vertreten"]);
    expect(c.score).toBe(15 + 10 - 20 - 30);
  });
});

describe("Vorschläge und Statistik (Demo-Schule)", () => {
  let h: DbHandle;
  const MO = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableSubstitutions);
  });
  afterAll(() => h.close());

  it("nur freie Lehrkräfte, Freisetzung vorne; Statistik zählt Vertretungen und Entfall", async () => {
    const all = (await h.db.select().from(timetableLessons)).filter((l) => l.weekday === 0);
    const target = all.find((l) => l.groupId === "g-7b" && l.teacherId)!;
    const busyNow = new Set(all.filter((l) => l.periodNr === target.periodNr).map((l) => l.teacherId));
    let s = await suggestSubstitutes(h.db, target.id, MO);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((c) => !busyNow.has(c.id))).toBe(true);
    expect(s.some((c) => c.id === target.teacherId)).toBe(false);

    // parallele Klasse auf Exkursion → deren Lehrkraft frei und ganz vorne
    const parallel = all.find((l) => l.periodNr === target.periodNr && l.groupId !== target.groupId && l.teacherId && l.teacherId !== target.teacherId)!;
    await createAbsence(h.db, "u-admin", {
      teacherId: null,
      groupId: parallel.groupId,
      startsOn: MO,
      endsOn: MO,
      fromPeriod: null,
      toPeriod: null,
      reason: "exkursion",
      note: null,
    });
    s = await suggestSubstitutes(h.db, target.id, MO);
    expect(s[0]!.id).toBe(parallel.teacherId);
    expect(s[0]!.reasons.map((r) => r.label)).toContain("frei durch Freisetzung");

    await saveSubstitution(h.db, "u-admin", { lessonId: target.id, date: MO, kind: "substitute", substituteId: s[0]!.id, roomId: null, note: null });
    await saveSubstitution(h.db, "u-admin", { lessonId: parallel.id, date: MO, kind: "cancel", substituteId: null, roomId: null, note: null });
    const st = await substitutionStats(h.db, "2026-08-01", "2027-07-31");
    expect(st.teachers.find((t) => t.id === parallel.teacherId)).toMatchObject({ substitutions: 1, cancelled: 1 });
    expect(st.teachers.find((t) => t.id === target.teacherId)).toMatchObject({ given: 1 });
    expect(st.groups.find((g) => g.id === "g-7b")).toMatchObject({ substituted: 1, cancelled: 0 });
    // im Schuljahr gezählt: Vertretung senkt die Punkte beim nächsten Mal
    const again = await suggestSubstitutes(h.db, target.id, MO);
    expect(again.find((c) => c.id === parallel.teacherId)!.reasons.map((r) => r.label)).toContain("1 Vertretung im Schuljahr");
  });
});
