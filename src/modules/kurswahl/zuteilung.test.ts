import { describe, expect, it } from "vitest";
import { allocate, demand, lotOrder, type AllocOffer, type AllocStudent } from "./zuteilung";

const offers: AllocOffer[] = [
  { id: "F", title: "Französisch", minSize: 0, maxSize: 2 },
  { id: "IF", title: "Informatik", minSize: 0, maxSize: 2 },
  { id: "DG", title: "Darstellen und Gestalten", minSize: 0, maxSize: null },
];
const s = (id: string, ...choices: string[]): AllocStudent => ({ id, choices });

describe("Zuteilung (rein)", () => {
  it("erfüllt Erstwünsche, solange Plätze reichen – mit Begründung", () => {
    const r = allocate(offers, [s("a", "F", "IF"), s("b", "IF", "F")], "seed");
    expect(r.assignments).toEqual([
      { studentId: "a", place: 1, offerId: "F", rank: 1, reason: "1. Wunsch erfüllt" },
      { studentId: "b", place: 1, offerId: "IF", rank: 1, reason: "1. Wunsch erfüllt" },
    ]);
    expect(r.log).toEqual([]);
  });

  it("losen bei Überbuchung: deterministisch je Seed, Verlierer bekommen den 2. Wunsch", () => {
    const students = [s("a", "F", "IF"), s("b", "F", "IF"), s("c", "F", "IF")];
    const r1 = allocate(offers, students, "seed-1");
    const r2 = allocate(offers, students, "seed-1");
    expect(r1).toEqual(r2);
    const inF = r1.assignments.filter((a) => a.offerId === "F").map((a) => a.studentId);
    expect(inF).toEqual(lotOrder("seed-1", ["a", "b", "c"]).slice(0, 2).sort());
    const loser = r1.assignments.find((a) => a.offerId === "IF")!;
    expect(loser.rank).toBe(2);
    expect(loser.reason).toBe("2. Wunsch erfüllt – 1. Wunsch „Französisch“ voll (Los)");
    expect(r1.log).toEqual(["Französisch, 1. Wunsch: 3 Bewerbungen auf 2 Plätze – Los"]);
    // anderer Seed kann anders losen, aber nie mehr als die Kapazität
    const r3 = allocate(offers, students, "anderer");
    expect(r3.assignments.filter((a) => a.offerId === "F")).toHaveLength(2);
  });

  it("Erstwünsche gehen Zweitwünschen vor (kein Verdrängen durch spätere Runden)", () => {
    const r = allocate(offers, [s("a", "IF", "F"), s("b", "F"), s("c", "F")], "x");
    expect(r.assignments.find((a) => a.studentId === "a")).toMatchObject({ offerId: "IF", rank: 1 });
    expect(r.assignments.filter((a) => a.offerId === "F").map((a) => a.studentId)).toEqual(["b", "c"]);
  });

  it("Mindestgröße: Angebot fällt aus, seine Wähler:innen rücken auf ihren nächsten Wunsch", () => {
    const withMin: AllocOffer[] = [{ ...offers[0]!, minSize: 2 }, offers[1]!, offers[2]!];
    const r = allocate(withMin, [s("a", "F", "DG"), s("b", "DG", "F"), s("c", "IF")], "x");
    expect(r.offers.find((o) => o.id === "F")).toEqual({ id: "F", count: 0, cancelled: true, reason: "Französisch fällt aus: 1 von mindestens 2" });
    expect(r.assignments.find((a) => a.studentId === "a")).toEqual({ studentId: "a", place: 1, offerId: "DG", rank: 2, reason: "2. Wunsch erfüllt – 1. Wunsch „Französisch“ fällt aus" });
    expect(r.log).toContain("Französisch fällt aus: 1 von mindestens 2");
  });

  it("Restplatz, wenn kein Wunsch geht; ohne Wahl bleibt offen; von Hand Zugeteilte stehen fest", () => {
    const small: AllocOffer[] = [
      { id: "F", title: "Französisch", minSize: 0, maxSize: 1 },
      { id: "IF", title: "Informatik", minSize: 0, maxSize: 3 },
    ];
    const r = allocate(small, [{ id: "m", choices: [], manual: "F" }, s("a", "F"), s("n")], "x");
    expect(r.assignments).toEqual([
      { studentId: "m", place: 1, offerId: "F", rank: null, reason: "von Hand zugeteilt" },
      { studentId: "a", place: 1, offerId: "IF", rank: null, reason: "Restplatz – 1. Wunsch „Französisch“ voll" },
      { studentId: "n", place: 1, offerId: null, rank: null, reason: "nicht gewählt – von Hand zuteilen" },
    ]);
  });

  it("Nachfrage je Angebot und Rang", () => {
    const d = demand(offers, [s("a", "F", "IF"), s("b", "F", "DG"), s("c", "IF", "F")], 2);
    expect(d).toEqual([
      { id: "F", byRank: [2, 1], total: 3 },
      { id: "IF", byRank: [1, 1], total: 2 },
      { id: "DG", byRank: [0, 1], total: 1 },
    ]);
  });

  describe("P4-67 Mehrfachwahl (Plätze)", () => {
    const m = (id: string, ...places: string[][]): AllocStudent => ({ id, choices: places[0] ?? [], places: places.map((choices) => ({ choices })) });

    it("ein Platz in `places` ergibt genau dasselbe wie `choices`", () => {
      const students = [s("a", "F", "IF"), s("b", "F", "IF"), s("c", "F", "IF")];
      expect(allocate(offers, students.map((x) => m(x.id, [...x.choices])), "seed-1")).toEqual(allocate(offers, students, "seed-1"));
    });

    it("kein Kurs doppelt: auf dem 2. Platz zählt ein schon zugeteilter Kurs als „schon zugeteilt“", () => {
      const r = allocate(offers, [m("a", ["F", "IF"], ["F", "DG"])], "x");
      expect(r.assignments).toEqual([
        { studentId: "a", place: 1, offerId: "F", rank: 1, reason: "1. Wunsch erfüllt" },
        { studentId: "a", place: 2, offerId: "DG", rank: 2, reason: "2. Wunsch erfüllt – 1. Wunsch „Französisch“ schon zugeteilt" },
      ]);
    });

    it("erst alle 1. Plätze, dann die 2. – Kapazität gilt über alle Plätze; Restplatz nie ein Kurs, den die Person hat", () => {
      const r = allocate(offers, [m("a", ["IF"], ["F"]), m("b", ["F"]), m("c", ["F"], ["IF"])], "x");
      const of = (id: string, place: number) => r.assignments.find((a) => a.studentId === id && a.place === place);
      // F (2 Plätze) geht an b und c (1. Plätze) – a bekommt auf Platz 2 einen Restplatz, nicht IF (hat a schon)
      expect(of("b", 1)).toMatchObject({ offerId: "F", rank: 1 });
      expect(of("c", 1)).toMatchObject({ offerId: "F", rank: 1 });
      expect(of("a", 1)).toMatchObject({ offerId: "IF", rank: 1 });
      expect(of("a", 2)).toEqual({ studentId: "a", place: 2, offerId: "DG", rank: null, reason: "Restplatz – 1. Wunsch „Französisch“ voll" });
      expect(of("c", 2)).toMatchObject({ offerId: "IF", rank: 1 });
      expect(r.offers.find((o) => o.id === "IF")!.count).toBe(2);
      for (const id of ["a", "b", "c"]) {
        const got = r.assignments.filter((x) => x.studentId === id && x.offerId).map((x) => x.offerId);
        expect(new Set(got).size).toBe(got.length);
      }
    });

    it("Los auf späteren Plätzen mit eigenem Seed, deterministisch; Protokoll nennt den Platz", () => {
      const small: AllocOffer[] = [
        { id: "A", title: "AG Schach", minSize: 0, maxSize: 1 },
        { id: "B", title: "AG Chor", minSize: 0, maxSize: 5 },
      ];
      const students = [m("a", ["B"], ["A"]), m("b", ["B"], ["A"]), m("c", ["B"], ["A"])];
      const r1 = allocate(small, students, "s");
      expect(r1).toEqual(allocate(small, students, "s"));
      const winner = r1.assignments.find((x) => x.place === 2 && x.offerId === "A")!.studentId;
      expect(winner).toBe(lotOrder("s#2", ["a", "b", "c"])[0]);
      expect(r1.log).toEqual(["AG Schach, 2. Platz, 1. Wunsch: 3 Bewerbungen auf 1 Plätze – Los"]);
    });

    it("von Hand auf einem Platz Zugeteiltes gilt für alle Plätze als „hat schon“; Mindestgröße zählt alle Plätze", () => {
      const withMin: AllocOffer[] = [{ ...offers[0]!, minSize: 2 }, offers[1]!, offers[2]!];
      const r = allocate(withMin, [{ id: "a", choices: ["F"], places: [{ choices: ["F", "IF"] }, { choices: [], manual: "F" }] }, m("b", ["DG"], ["F"])], "x");
      const of = (id: string, place: number) => r.assignments.find((a) => a.studentId === id && a.place === place);
      expect(of("a", 2)).toMatchObject({ offerId: "F", reason: "von Hand zugeteilt" });
      expect(of("a", 1)).toMatchObject({ offerId: "IF", rank: 2 });
      // F hat 2 (a von Hand auf Platz 2, b auf Platz 2) – von Hand hält F ohnehin am Leben
      expect(r.offers.find((o) => o.id === "F")).toMatchObject({ count: 2, cancelled: false });
      // ohne Hand-Zuteilung: F nur mit b → fällt aus, b rückt auf den Restplatz
      const r2 = allocate(withMin, [m("b", ["DG"], ["F"])], "x");
      expect(r2.offers.find((o) => o.id === "F")).toMatchObject({ cancelled: true });
      expect(r2.assignments.find((a) => a.place === 2)).toMatchObject({ offerId: "IF", rank: null });
    });

    it("weitere Plätze sind freiwillig: ohne Wünsche dort keine Zeile", () => {
      const r = allocate(offers, [m("a", ["F"], [])], "x");
      expect(r.assignments).toEqual([{ studentId: "a", place: 1, offerId: "F", rank: 1, reason: "1. Wunsch erfüllt" }]);
    });
  });
});
