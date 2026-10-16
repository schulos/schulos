import { describe, expect, it } from "vitest";
import type { LessonSlot } from "./service";
import { dayStrip, firstDayWithLessons } from "./today";

const slot = (date: string, periodNr: number, startsAt: string, endsAt: string): LessonSlot => ({
  lessonId: `l${periodNr}`,
  date,
  weekday: 0,
  periodNr,
  startsAt,
  endsAt,
  subjectId: "D",
  subjectName: "Deutsch",
  color: "#D9480F",
  groupId: "g-7b",
  groupName: "Klasse 7b",
  teacherId: null,
  teacherName: null,
  teacherCode: null,
  roomId: null,
  week: "all",
  couplingId: null,
});
const MO = "2026-10-05";
const slots = [slot(MO, 1, "08:00", "08:45"), slot(MO, 2, "08:50", "09:35"), slot(MO, 3, "09:55", "10:40"), slot("2026-10-06", 1, "08:00", "08:45")];

describe("dayStrip", () => {
  it("markiert vergangene, laufende und kommende Stunden mit Restminuten", () => {
    expect(dayStrip(slots, MO, MO, "09:12").map((s) => [s.periodNr, s.state, s.minutesLeft])).toEqual([
      [1, "done", undefined],
      [2, "now", 23],
      [3, "later", undefined],
    ]);
  });
  it("Pause zählt nicht als laufende Stunde; Stundenende ist exklusiv", () => {
    expect(dayStrip(slots, MO, MO, "09:40").map((s) => s.state)).toEqual(["done", "done", "later"]);
    expect(dayStrip(slots, MO, MO, "08:45").map((s) => s.state)).toEqual(["done", "later", "later"]);
  });
  it("andere Tage: vorher alles erledigt, danach alles kommend", () => {
    expect(dayStrip(slots, MO, "2026-10-06", "07:00").every((s) => s.state === "done")).toBe(true);
    expect(dayStrip(slots, "2026-10-06", MO, "12:00").map((s) => s.state)).toEqual(["later"]);
  });
});

describe("firstDayWithLessons", () => {
  it("findet den nächsten Tag mit Unterricht", () => {
    expect(firstDayWithLessons(slots, "2026-10-03")).toBe(MO);
    expect(firstDayWithLessons(slots, "2026-10-06")).toBe("2026-10-06");
    expect(firstDayWithLessons(slots, "2026-10-07")).toBeNull();
  });
});
