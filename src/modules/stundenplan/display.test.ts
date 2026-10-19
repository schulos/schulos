import { describe, expect, it } from "vitest";
import { coupledGroupLabel, mergeCoupled, slotDisplay, subjectLabel } from "./display";
import type { LessonSlot } from "./service";

const base: LessonSlot = {
  lessonId: "l",
  date: "2026-10-05",
  weekday: 0,
  periodNr: 4,
  startsAt: "10:45",
  endsAt: "11:30",
  subjectId: "M",
  subjectName: "Mathematik",
  color: "#1971C2",
  groupId: "g-6b",
  groupName: "Klasse 6b",
  teacherId: "kle",
  teacherName: "Tobias Kleine",
  teacherCode: "KLE",
  roomId: "112",
  week: "all",
  couplingId: null,
};
const sub = { kind: "substitute" as const, substituteId: "bra", substituteName: "Jana Brandt", substituteCode: "BRA", roomId: "015", note: "Arbeitsheft S. 24" };

describe("slotDisplay", () => {
  it("regulär je nach Sicht", () => {
    expect(slotDisplay(base, "student").detail).toBe("KLE · R 112");
    expect(slotDisplay(base, "student", true).detail).toBe("Tobias Kleine · R 112");
    expect(slotDisplay(base, "teacher").detail).toBe("Klasse 6b · R 112");
    expect(slotDisplay(base, "room").detail).toBe("Klasse 6b · KLE");
  });
  it("Vertretung für die Klasse: orange, neue Lehrkraft und Raum, Hinweis", () => {
    expect(slotDisplay({ ...base, change: sub }, "student")).toEqual({ tone: "sub", tag: "Vertretung", detail: "BRA · R 015", note: "Arbeitsheft S. 24", struck: false });
  });
  it("Vertretungslehrkraft sieht „für KLE“, vertretene Lehrkraft „durch BRA“ durchgestrichen", () => {
    expect(slotDisplay({ ...base, change: sub, perspective: "covering" }, "teacher")).toMatchObject({ tone: "sub", detail: "Klasse 6b · R 015 · für KLE" });
    expect(slotDisplay({ ...base, change: sub, perspective: "away" }, "teacher")).toMatchObject({ tone: "off", tag: "Vertreten", detail: "Klasse 6b · durch BRA", struck: true });
  });
  it("SP-12: Fachtausch – darunter „statt Sport“, abgebende Lehrkraft ohne Zusatz", () => {
    const alt = { ...base, subjectId: "M", subjectName: "Mathematik", change: { ...sub, insteadOf: "Sport", subjectId: "M", subjectName: "Mathematik" } };
    expect(slotDisplay(alt, "student").detail).toBe("statt Sport · BRA · R 015");
    expect(slotDisplay({ ...alt, perspective: "covering" }, "teacher").detail).toBe("statt Sport · Klasse 6b · R 015 · für KLE");
    expect(slotDisplay({ ...alt, subjectName: "Sport", perspective: "away", change: { ...alt.change, insteadOf: null } }, "teacher").detail).toBe("Klasse 6b · durch BRA");
    expect(subjectLabel("Mathematik", "Sport")).toBe("Mathematik statt Sport");
    expect(subjectLabel("Mathematik", null)).toBe("Mathematik");
  });
  it("Entfall, Raumänderung, Raumplan", () => {
    expect(slotDisplay({ ...base, change: { ...sub, kind: "cancel", substituteId: null, substituteCode: null, substituteName: null, roomId: null } }, "student")).toMatchObject({
      tone: "off",
      tag: "Entfällt",
      struck: true,
    });
    const roomChange = { ...sub, kind: "room" as const, substituteId: null, substituteCode: null, substituteName: null };
    expect(slotDisplay({ ...base, change: roomChange }, "student")).toMatchObject({ tag: "Raumänderung", detail: "KLE · R 015" });
    expect(slotDisplay({ ...base, change: roomChange, perspective: "away" }, "room")).toMatchObject({ tag: "Verlegt", detail: "Klasse 6b · → R 015" });
    expect(slotDisplay({ ...base, change: sub, perspective: "covering" }, "room")).toMatchObject({ tag: "Verlegt hierher", detail: "Klasse 6b · BRA" });
  });
});

describe("mergeCoupled", () => {
  const part = (lessonId: string, groupId: string, groupName: string, extra: Partial<LessonSlot> = {}): LessonSlot => ({ ...base, lessonId, groupId, groupName, couplingId: "k1", ...extra });

  it("fasst Teile derselben Lehrkraft und desselben Raums zusammen, andere bleiben getrennt", () => {
    const merged = mergeCoupled([
      part("a", "g-7a", "Klasse 7a"),
      part("b", "g-7b", "Klasse 7b"),
      part("c", "g-7b", "Klasse 7b", { teacherId: "lin", teacherCode: "LIN" }),
      part("d", "g-7c", "Klasse 7c", { change: { kind: "cancel", substituteId: null, substituteName: null, substituteCode: null, roomId: null, note: null } }),
      { ...base, lessonId: "e" },
    ]);
    expect(merged.map((s) => `${s.lessonId}:${s.groupName}`)).toEqual(["a:7a, 7b", "c:Klasse 7b", "d:Klasse 7c", "e:Klasse 6b"]);
    expect(merged[0]!.coupledGroups).toEqual([
      { id: "g-7a", name: "Klasse 7a" },
      { id: "g-7b", name: "Klasse 7b" },
    ]);
  });

  it("kürzt Klassennamen", () => {
    expect(coupledGroupLabel(["Klasse 9a", "9 WP Informatik"])).toBe("9a, 9 WP Informatik");
  });
});
