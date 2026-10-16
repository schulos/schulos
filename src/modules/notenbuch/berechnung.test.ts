// Notenbuch (P5-10): Rechenlogik als Tabellentests – Skalen, Eingaben, Notenschlüssel, Gewichtung, Rundung, Tendenz.
import { describe, expect, it } from "vitest";
import {
  computeStudent,
  distribution,
  weightsSum,
  wholeGrade,
  defaultKey,
  formatAverage,
  gradeFromPoints,
  keyError,
  normalizeInput,
  numericValue,
  parseEntry,
  roundToScale,
  scaleValues,
  weightsError,
  type ColumnSpec,
  type GradeKey,
  type Scale,
} from "./berechnung";

const col = (id: string, kind: ColumnSpec["kind"], weight = 100, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ id, kind, weight, ...extra });
const entries = (o: Record<string, string>) => new Map(Object.entries(o));

describe("Skalen", () => {
  it("Stufen von der besten zur schlechtesten", () => {
    expect(scaleValues("noten6")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(scaleValues("noten6_tendenz")).toHaveLength(16);
    expect(scaleValues("noten6_tendenz")[0]).toBe("1+");
    expect(scaleValues("noten6_tendenz").at(-1)).toBe("6");
    expect(scaleValues("punkte15")).toHaveLength(16);
  });

  it.each([
    ["noten6", "1", 1],
    ["noten6", "6", 6],
    ["noten6_tendenz", "1+", 2 / 3],
    ["noten6_tendenz", "1", 1],
    ["noten6_tendenz", "1-", 4 / 3],
    ["noten6_tendenz", "2+", 5 / 3],
    ["noten6_tendenz", "3", 3],
    ["noten6_tendenz", "5-", 16 / 3],
    ["noten6_tendenz", "6", 6],
    ["punkte15", "15", 15],
    ["punkte15", "0", 0],
  ] as [Scale, string, number][])("%s: „%s“ = %d", (scale, label, value) => {
    expect(numericValue(scale, label)).toBeCloseTo(value, 9);
  });

  it("unbekannte Stufe ist ein Programmfehler", () => {
    expect(() => numericValue("noten6", "7")).toThrow();
  });
});

describe("Eingaben", () => {
  it.each([
    [" 2 ", "2"],
    ["2−", "2-"],
    ["2–", "2-"],
    ["FEHLT", "fehlt"],
    ["Befreit", "befreit"],
    ["23,5", "23.5"],
    ["", ""],
  ])("normalisiert „%s“ → „%s“", (raw, out) => {
    expect(normalizeInput(raw)).toBe(out);
  });

  it.each([
    ["noten6", "3", { kind: "grade", label: "3", value: 3 }],
    ["noten6", "fehlt", { kind: "fehlt" }],
    ["noten6", "befreit", { kind: "befreit" }],
    ["noten6", "   ", { kind: "empty" }],
    ["noten6_tendenz", "2−", { kind: "grade", label: "2-" }],
    ["punkte15", "11", { kind: "grade", label: "11", value: 11 }],
  ] as [Scale, string, object][])("%s: „%s“ gültig", (scale, raw, expected) => {
    expect(parseEntry(raw, scale)).toMatchObject(expected);
  });

  it.each([
    ["noten6", "0"],
    ["noten6", "7"],
    ["noten6", "2+"],
    ["noten6", "2,5"],
    ["noten6_tendenz", "6-"],
    ["noten6_tendenz", "6+"],
    ["noten6_tendenz", "1++"],
    ["punkte15", "16"],
    ["punkte15", "-1"],
    ["punkte15", "abc"],
  ] as [Scale, string][])("%s: „%s“ ungültig, mit Hinweis", (scale, raw) => {
    const r = parseEntry(raw, scale);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.error).toMatch(/Gültig sind/);
  });

  it("Spalte mit Höchstpunktzahl: Punkte → Note nach Schlüssel, Grenzen geprüft", () => {
    const c = { maxPoints: 40, key: null };
    expect(parseEntry("34", "noten6", c)).toMatchObject({ kind: "grade", label: "1", points: 34 }); // 85 %
    expect(parseEntry("33,5", "noten6", c)).toMatchObject({ kind: "grade", label: "2", points: 33.5 }); // 83,75 %
    expect(parseEntry("0", "noten6", c)).toMatchObject({ kind: "grade", label: "6" });
    expect(parseEntry("40", "punkte15", c)).toMatchObject({ kind: "grade", label: "15" });
    expect(parseEntry("41", "noten6", c)).toMatchObject({ kind: "invalid", error: /Höchstens 40/ });
    expect(parseEntry("-1", "noten6", c)).toMatchObject({ kind: "invalid" });
    expect(parseEntry("2+", "noten6", c)).toMatchObject({ kind: "invalid", error: /Punkte/ });
    expect(parseEntry("fehlt", "noten6", c)).toEqual({ kind: "fehlt" });
  });
});

describe("Notenschlüssel", () => {
  it("Vorgaben sind gültig und decken 0–100 % ab", () => {
    for (const s of ["noten6", "noten6_tendenz", "punkte15"] as Scale[]) {
      expect(keyError(defaultKey(s), s), s).toBeNull();
      expect(defaultKey(s).at(-1)!.min).toBe(0);
    }
  });

  it.each([
    [[], /leer/],
    [[{ min: 50, grade: "1" }, { min: 0, grade: "7" }], /kein gültiger Wert/],
    [[{ min: 50, grade: "2" }, { min: 0, grade: "1" }], /besten zur schlechtesten/],
    [[{ min: 50, grade: "1" }, { min: 0, grade: "1" }], /jede nur einmal/],
    [[{ min: 50, grade: "1" }, { min: 60, grade: "2" }, { min: 0, grade: "6" }], /kleiner werden/],
    [[{ min: 50, grade: "1" }, { min: 10, grade: "6" }], /0 %/],
    [[{ min: 120, grade: "1" }, { min: 0, grade: "6" }], /0 und 100/],
  ] as [GradeKey, RegExp][])("ungültiger Schlüssel %#", (key, msg) => {
    expect(keyError(key, "noten6")).toMatch(msg);
  });

  it.each([
    // Grenze einschließlich: genau 85 % ist noch eine 1
    [34, 40, "1"],
    [33.99, 40, "2"],
    [28, 40, "2"], // 70 %
    [27.99, 40, "3"],
    [16, 40, "4"], // 40 %
    [8, 40, "5"], // 20 %
    [7.99, 40, "6"],
    [0, 40, "6"],
    [17, 20, "1"], // 85 % bei anderer Höchstpunktzahl
  ])("%d von %d Punkten → %s (Noten 1–6)", (p, max, grade) => {
    expect(gradeFromPoints(p, max, defaultKey("noten6"))).toBe(grade);
  });

  it.each([
    [95, "15"],
    [94.9, "14"],
    [50, "6"],
    [45, "5"],
    [40, "4"],
    [39.9, "3"],
    [20, "1"],
    [19.9, "0"],
  ])("%d %% → %s Punkte (Abitur-Grenzen)", (pct, label) => {
    expect(gradeFromPoints(pct, 100, defaultKey("punkte15"))).toBe(label);
  });

  it("Gleitkomma: 1/3 der Punkte liegt nicht knapp unter 33 %", () => {
    // 33 von 100 → genau 33 % → 3 Punkte; 11 von 33,333 wäre sonst 32,99999…
    expect(gradeFromPoints(33, 100, defaultKey("punkte15"))).toBe("3");
    expect(gradeFromPoints(0.7, 1, [{ min: 70, grade: "1" }, { min: 0, grade: "6" }])).toBe("1");
  });

  it("eigener Schlüssel je Spalte", () => {
    const strict: GradeKey = [
      { min: 92, grade: "1" },
      { min: 81, grade: "2" },
      { min: 67, grade: "3" },
      { min: 50, grade: "4" },
      { min: 30, grade: "5" },
      { min: 0, grade: "6" },
    ];
    expect(keyError(strict, "noten6")).toBeNull();
    expect(parseEntry("36", "noten6", { maxPoints: 40, key: strict })).toMatchObject({ label: "2" }); // 90 %
    expect(parseEntry("30", "noten6", { maxPoints: 40, key: strict })).toMatchObject({ label: "3" }); // 75 %
  });
});

describe("Rundung (x,5 zugunsten der Schüler:in)", () => {
  it.each([
    [1, "1"],
    [1.4999, "1"],
    [1.5, "1"],
    [1.5001, "2"],
    [2.49, "2"],
    [2.5, "2"],
    [2.51, "3"],
    [5.5, "5"],
    [5.51, "6"],
    [6, "6"],
    [2.5000000001, "2"], // Gleitkomma-Rest zählt nicht
  ])("Noten 1–6: %d → %s", (avg, grade) => {
    expect(roundToScale("noten6", avg)).toBe(grade);
  });

  it.each([
    [15, "15"],
    [10.5, "11"],
    [10.4999, "10"],
    [0.5, "1"],
    [0.49, "0"],
    [0, "0"],
    [10.4999999999, "11"], // Gleitkomma-Rest zählt nicht
  ])("15 Punkte: %d → %s", (avg, grade) => {
    expect(roundToScale("punkte15", avg)).toBe(grade);
  });

  it.each([
    [2 / 3, "1+"],
    [1, "1"],
    [7 / 6, "1"], // genau zwischen 1 und 1− → zugunsten: 1
    [7 / 6 + 0.001, "1-"],
    [4 / 3, "1-"],
    [1.5, "1-"], // 12,5 Punkte → 13
    [1.5 + 0.001, "2+"],
    [2, "2"],
    [2.2, "2-"], // 10,4 → 10
    [3, "3"],
    [16 / 3, "5-"],
    [5.5, "5-"], // 0,75 Punkte → 1
    // G5A-C10: zwischen 5− (1 P) und 6 (0 P) stückweise – 5− und 6 gleich gewichtet (Ø 17/3) = 0,5 P → zugunsten 5−
    [5.6, "5-"],
    [17 / 3, "5-"],
    [5.67, "6"],
    [5.8, "6"],
    [6, "6"],
  ])("Tendenz: %d → %s", (avg, grade) => {
    expect(roundToScale("noten6_tendenz", avg)).toBe(grade);
  });
});

describe("Rundung kaufmännisch (Q-5A-1: Einstellung je Schule)", () => {
  it.each([
    [1.4999, "1"],
    [1.5, "2"],
    [2.5, "3"],
    [2.5000000001, "3"], // Gleitkomma-Rest zählt nicht
    [2.4999999999, "3"],
    [2.49, "2"],
    [5.5, "6"],
    [6, "6"],
  ])("Noten 1–6: %d → %s", (avg, grade) => {
    expect(roundToScale("noten6", avg, "kaufmaennisch")).toBe(grade);
  });

  it.each([
    [10.5, "11"],
    [10.4999, "10"],
    [0.5, "1"],
  ])("15 Punkte (gleich wie zugunsten): %d → %s", (avg, grade) => {
    expect(roundToScale("punkte15", avg, "kaufmaennisch")).toBe(roundToScale("punkte15", avg, "schueler"));
    expect(roundToScale("punkte15", avg, "kaufmaennisch")).toBe(grade);
  });

  it.each([
    [7 / 6, "1-"], // genau zwischen 1 und 1− → schlechtere Stufe
    [1.5, "2+"], // 12,5 Punkte → 12
    [2.5, "3+"], // 9,5 Punkte → 9
    [1.5 - 0.001, "1-"],
    [2, "2"],
    [17 / 3, "6"], // zwischen 5− und 6
    [5.6, "5-"],
  ])("Tendenz: %d → %s", (avg, grade) => {
    expect(roundToScale("noten6_tendenz", avg, "kaufmaennisch")).toBe(grade);
  });

  it("computeStudent nimmt die Regel mit; Vorgabe bleibt zugunsten der Schüler:in", () => {
    const cols = [
      { id: "a", kind: "schriftlich" as const, weight: 100 },
      { id: "b", kind: "schriftlich" as const, weight: 100 },
    ];
    const entries = new Map([
      ["a", "2"],
      ["b", "3"],
    ]);
    expect(computeStudent("noten6", { schriftlich: 100 }, cols, entries).grade).toBe("2");
    expect(computeStudent("noten6", { schriftlich: 100 }, cols, entries, "schueler").grade).toBe("2");
    expect(computeStudent("noten6", { schriftlich: 100 }, cols, entries, "kaufmaennisch").grade).toBe("3");
  });
});

describe("Gewichteter Durchschnitt", () => {
  const cols = [col("ka1", "schriftlich"), col("ka2", "schriftlich"), col("m1", "sonstige"), col("m2", "sonstige", 200)];
  const w = { schriftlich: 50, sonstige: 50 };

  it("G5A-C10: Tendenz – eine 5− und eine 6 gleich gewichtet ergeben 5− (über die Punkte, zugunsten)", () => {
    const r = computeStudent("noten6_tendenz", w, [col("m1", "sonstige"), col("m2", "sonstige")], entries({ m1: "5-", m2: "6" }));
    expect(r.grade).toBe("5-");
  });

  it("je Art gewichtet, dann nach Buchgewichten", () => {
    // schriftlich (2+3)/2 = 2,5; sonstige (1·100 + 4·200)/300 = 3; gesamt 2,75 → 3
    const r = computeStudent("noten6", w, cols, entries({ ka1: "2", ka2: "3", m1: "1", m2: "4" }));
    expect(r.byKind).toEqual({ schriftlich: 2.5, sonstige: 3 });
    expect(r.average).toBe(2.75);
    expect(r.grade).toBe("3");
    expect(r.counted).toBe(4);
    expect(formatAverage(r.average)).toBe("2,75");
  });

  it("leere Spalten und keine Spalten: kein Durchschnitt", () => {
    expect(computeStudent("noten6", w, [], entries({}))).toMatchObject({ average: null, grade: null, counted: 0 });
    expect(computeStudent("noten6", w, cols, entries({}))).toMatchObject({ average: null, grade: null, counted: 0 });
    expect(formatAverage(null)).toBe("–");
  });

  it("„fehlt“ und „befreit“ zählen nicht – auch nicht im Gewicht", () => {
    const r = computeStudent("noten6", w, cols, entries({ ka1: "2", ka2: "fehlt", m1: "befreit", m2: "4" }));
    expect(r.byKind).toEqual({ schriftlich: 2, sonstige: 4 });
    expect(r.average).toBe(3);
    expect(r.counted).toBe(2);
  });

  it("alles befreit: kein Durchschnitt", () => {
    expect(computeStudent("noten6", w, cols, entries({ ka1: "befreit", ka2: "befreit", m1: "befreit", m2: "fehlt" }))).toMatchObject({
      average: null,
      grade: null,
      counted: 0,
    });
  });

  it("Art ohne Werte fällt heraus – die andere zählt voll", () => {
    const r = computeStudent("noten6", w, cols, entries({ m1: "2", m2: "3" }));
    expect(r.byKind.schriftlich).toBeNull();
    expect(r.average).toBeCloseTo(8 / 3, 9);
    expect(r.grade).toBe("3");
  });

  it.each([
    // Summe ≠ 100: normiert
    [{ schriftlich: 60, sonstige: 60 }, 2.5],
    [{ schriftlich: 30, sonstige: 10 }, 1.75],
    [{ schriftlich: 100, sonstige: 0 }, 1],
    [{ schriftlich: 0, sonstige: 100 }, 4],
    [{ schriftlich: 70 }, 1], // fehlende Art = 0 %
  ])("Gewichte %o → %d", (weights, avg) => {
    const r = computeStudent("noten6", weights, [col("a", "schriftlich"), col("b", "sonstige")], entries({ a: "1", b: "4" }));
    expect(r.average).toBeCloseTo(avg, 9);
  });

  it("nur Arten mit Gewicht 0 haben Werte: kein Durchschnitt", () => {
    expect(computeStudent("noten6", { schriftlich: 100, sonstige: 0 }, cols, entries({ m1: "2" })).average).toBeNull();
  });

  it("Spalte mit Gewicht 0 zählt nicht", () => {
    const r = computeStudent("noten6", w, [col("a", "sonstige"), col("b", "sonstige", 0)], entries({ a: "2", b: "6" }));
    expect(r.average).toBe(2);
    expect(r.counted).toBe(1);
  });

  it("ungültige Eingaben werden gemeldet und zählen nicht", () => {
    const r = computeStudent("noten6", w, [col("a", "sonstige"), col("b", "sonstige")], entries({ a: "2", b: "2+" }));
    expect(r.invalid).toEqual(["b"]);
    expect(r.average).toBe(2);
  });

  it("Spalte mit Punkten und Schlüssel neben Notenspalten", () => {
    const r = computeStudent(
      "noten6",
      w,
      [col("ka", "schriftlich", 100, { maxPoints: 50 }), col("m", "sonstige")],
      entries({ ka: "36", m: "2" }), // 72 % → 2
    );
    expect(r.byKind).toEqual({ schriftlich: 2, sonstige: 2 });
    expect(r.grade).toBe("2");
  });

  it("Tendenz-Skala: Durchschnitt in Dritteln, Vorschlag mit Tendenz", () => {
    const r = computeStudent("noten6_tendenz", w, [col("a", "schriftlich"), col("b", "sonstige")], entries({ a: "2+", b: "2-" }));
    expect(r.average).toBeCloseTo(2, 9);
    expect(r.grade).toBe("2");
    const r2 = computeStudent("noten6_tendenz", w, [col("a", "schriftlich"), col("b", "sonstige")], entries({ a: "1", b: "2" }));
    expect(r2.average).toBe(1.5);
    expect(r2.grade).toBe("1-"); // genau auf der Grenze → zugunsten
  });

  it("15 Punkte: x,5 wird aufgerundet", () => {
    const r = computeStudent("punkte15", w, [col("a", "schriftlich"), col("b", "sonstige")], entries({ a: "10", b: "11" }));
    expect(r.average).toBe(10.5);
    expect(r.grade).toBe("11");
    expect(formatAverage(r.average)).toBe("10,50");
  });

  it("Rundungsgrenze x,5 bei Noten über gewichtete Spalten: 2,5 → 2", () => {
    const r = computeStudent("noten6", { sonstige: 100 }, [col("a", "sonstige", 100), col("b", "sonstige", 300)], entries({ a: "4", b: "2" }));
    expect(r.average).toBe(2.5);
    expect(r.grade).toBe("2");
  });

  it("Drittel: (1 + 3 + 3) / 3 = 2,33 → 2", () => {
    const r = computeStudent("noten6", { sonstige: 100 }, [col("a", "sonstige"), col("b", "sonstige"), col("c", "sonstige")], entries({ a: "1", b: "3", c: "3" }));
    expect(r.average).toBeCloseTo(7 / 3, 9);
    expect(r.grade).toBe("2");
  });
});

describe("Gewichte prüfen", () => {
  it.each([
    [{ schriftlich: 50, sonstige: 50 }, null],
    [{ schriftlich: 60, sonstige: 60 }, null],
    [{ sonstige: 100 }, null],
    [{ schriftlich: 0, sonstige: 0 }, /Mindestens/],
    [{}, /Mindestens/],
    [{ schriftlich: 101 }, /0 bis 100/],
    [{ schriftlich: -5, sonstige: 50 }, /0 bis 100/],
    [{ schriftlich: 33.3, sonstige: 66.7 }, /ganze/],
  ])("%o", (weights, msg) => {
    const e = weightsError(weights);
    if (msg === null) expect(e).toBeNull();
    else expect(e).toMatch(msg);
  });
});

describe("Notenspiegel (P5-12)", () => {
  it("ganze Noten aus Tendenz und 15 Punkten", () => {
    expect(["1+", "1", "1-", "2+", "4-", "6"].map((g) => wholeGrade("noten6_tendenz", g))).toEqual(["1", "1", "1", "2", "4", "6"]);
    expect(["15", "13", "12", "10", "9", "7", "6", "4", "3", "1", "0"].map((g) => wholeGrade("punkte15", g))).toEqual(["1", "1", "2", "2", "3", "3", "4", "4", "5", "5", "6"]);
    expect(wholeGrade("noten6", "3")).toBe("3");
  });

  it("zählt je Note ohne Namen, fehlt/befreit getrennt, ungültig und leer gar nicht", () => {
    const d = distribution("noten6_tendenz", {}, ["1-", "2+", "2", "fehlt", "befreit", "befreit", "7", ""]);
    expect(d.buckets).toEqual([
      { grade: "1", count: 1 },
      { grade: "2", count: 2 },
      { grade: "3", count: 0 },
      { grade: "4", count: 0 },
      { grade: "5", count: 0 },
      { grade: "6", count: 0 },
    ]);
    expect(d).toMatchObject({ count: 3, fehlt: 1, befreit: 2 });
    expect(formatAverage(d.average)).toBe("1,67"); // (1⅓ + 1⅔ + 2) / 3
    expect(distribution("noten6", {}, []).average).toBeNull();
  });

  it("Punkte-Spalten über den Schlüssel", () => {
    const d = distribution("noten6", { maxPoints: 40, key: null }, ["40", "34", "20", "3"]);
    expect(d.buckets.map((b) => b.count)).toEqual([2, 0, 0, 1, 0, 1]);
  });

  it("Summe der Gewichte", () => {
    expect(weightsSum({ schriftlich: 60, sonstige: 40 })).toBe(100);
    expect(weightsSum({ schriftlich: 75 })).toBe(75);
  });
});
