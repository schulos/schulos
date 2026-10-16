import { describe, expect, it } from "vitest";
import { arrangeSeats, deskKey, keepSeatsOnDesks, layoutError, presetDesks, seatInitials, seatsError, sortDesks } from "./layout";
import { pickPlan } from "./service";

describe("Sitzplan – Raster und Vorlagen (P5-02)", () => {
  it("Reihen mit Zweiertischen lassen jede dritte Spalte als Gang frei", () => {
    expect(presetDesks("reihen", 2, 5)).toEqual(["0:0", "0:1", "0:3", "0:4", "1:0", "1:1", "1:3", "1:4"]);
  });
  it("Gruppentische: Blöcke 2×2 mit Gängen", () => {
    const d = presetDesks("gruppen", 5, 5);
    expect(d).toHaveLength(16);
    expect(d).not.toContain("2:0");
    expect(d).not.toContain("0:2");
  });
  it("U-Form: Seiten und hintere Reihe, vorn offen", () => {
    const d = new Set(presetDesks("u-form", 4, 5));
    expect(d.has("0:0") && d.has("0:4") && d.has("3:2")).toBe(true);
    expect(d.has("0:2") || d.has("1:2")).toBe(false);
  });
  it("prüft Raster und Tische", () => {
    expect(layoutError(0, 4, [])).toMatch(/Reihen/);
    expect(layoutError(4, 13, [])).toMatch(/Plätze je Reihe/);
    expect(layoutError(2, 2, ["2:0"])).toMatch(/außerhalb/);
    expect(layoutError(2, 2, ["0:0", "0:0"])).toMatch(/doppelt/);
    expect(layoutError(2, 2, ["x"])).toMatch(/außerhalb/);
    expect(layoutError(2, 2, ["0:0", "1:1"])).toBeNull();
  });
  it("sortiert Tische von vorn links nach hinten rechts", () => {
    expect(sortDesks(["1:0", "0:10", "0:2"])).toEqual(["0:2", "0:10", "1:0"]);
  });
});

describe("Sitzplan – Plätze (P5-02)", () => {
  const desks = ["0:0", "0:1", "1:0"];
  const group = new Set(["a", "b", "c", "d"]);
  it("nur Personen der Gruppe, nur auf Tischen, je Tisch eine Person, jede Person einmal", () => {
    expect(seatsError([{ studentId: "x", row: 0, col: 0 }], desks, group)).toMatch(/gehört nicht/);
    expect(seatsError([{ studentId: "a", row: 1, col: 1 }], desks, group)).toMatch(/kein Tisch/);
    expect(
      seatsError(
        [
          { studentId: "a", row: 0, col: 0 },
          { studentId: "b", row: 0, col: 0 },
        ],
        desks,
        group,
      ),
    ).toMatch(/doppelt belegt/);
    expect(
      seatsError(
        [
          { studentId: "a", row: 0, col: 0 },
          { studentId: "a", row: 0, col: 1 },
        ],
        desks,
        group,
      ),
    ).toMatch(/doppelt/);
    expect(seatsError([{ studentId: "a", row: 0, col: 1 }], desks, group)).toBeNull();
  });
  it("alphabetisch: in der Reihenfolge der Liste von vorn links; Überzählige bleiben ohne Platz", () => {
    expect(arrangeSeats(["a", "b", "c", "d"], desks, "alphabetisch")).toEqual([
      { studentId: "a", row: 0, col: 0 },
      { studentId: "b", row: 0, col: 1 },
      { studentId: "c", row: 1, col: 0 },
    ]);
  });
  it("zufällig: gleicher Startwert, gleiche Verteilung; alle verschieden", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const many = presetDesks("alle", 4, 6);
    const one = arrangeSeats(ids, many, "zufaellig", "abc");
    expect(arrangeSeats(ids, many, "zufaellig", "abc")).toEqual(one);
    expect(new Set(one.map((s) => s.studentId)).size).toBe(20);
    expect(new Set(one.map((s) => deskKey(s.row, s.col))).size).toBe(20);
    expect(one.map((s) => s.studentId)).not.toEqual(ids);
    expect(arrangeSeats(ids, many, "zufaellig", "xyz")).not.toEqual(one);
  });
  it("entfernte Tische nehmen den Platz mit", () => {
    expect(
      keepSeatsOnDesks(
        [
          { studentId: "a", row: 0, col: 0 },
          { studentId: "b", row: 2, col: 2 },
        ],
        desks,
      ),
    ).toEqual([{ studentId: "a", row: 0, col: 0 }]);
  });
  it("Initialen aus Vor- und Nachname", () => {
    expect(seatInitials("Lea", "Schäfer")).toBe("LS");
    expect(seatInitials("", "")).toBe("?");
  });
});

describe("Sitzplan – passender Plan zur Stunde (P5-03)", () => {
  const at = (d: string) => new Date(`2026-10-0${d}T10:00:00Z`);
  const plans = [
    { id: "allg", subjectId: null, roomId: null, updatedAt: at("1") },
    { id: "m", subjectId: "M", roomId: null, updatedAt: at("2") },
    { id: "m-106", subjectId: "M", roomId: "106", updatedAt: at("1") },
    { id: "d", subjectId: "D", roomId: null, updatedAt: at("3") },
    { id: "nw", subjectId: null, roomId: "NW1", updatedAt: at("4") },
  ];
  it("Fach und Raum vor Fach vor Raum vor allgemein; fremdes Fach/fremder Raum nie", () => {
    expect(pickPlan(plans, { subjectId: "M", roomId: "106" })?.id).toBe("m-106");
    expect(pickPlan(plans, { subjectId: "M", roomId: "107" })?.id).toBe("m");
    expect(pickPlan(plans, { subjectId: "E", roomId: "NW1" })?.id).toBe("nw");
    expect(pickPlan(plans, { subjectId: "E", roomId: null })?.id).toBe("allg");
    expect(pickPlan(plans.slice(1, 2), { subjectId: "E", roomId: null })).toBeNull();
  });
});
