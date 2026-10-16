import { describe, expect, it } from "vitest";
import { formName, gradeTemplate, levelTemplate, STATES } from "./catalog";

const codes = (p: Parameters<typeof gradeTemplate>[0]) => gradeTemplate(p).map((g) => g.code);

describe("Schulform-Katalog", () => {
  it("kennt alle 16 Länder", () => {
    expect(STATES).toHaveLength(16);
  });

  it("Gesamtschule NRW: 5–10 + EF/Q1/Q2, Niveaus E/G und GK/LK", () => {
    const p = { state: "NW", form: "gesamtschule", oberstufe: true, abitur: "g9" } as const;
    expect(codes(p)).toEqual(["5", "6", "7", "8", "9", "10", "EF", "Q1", "Q2"]);
    expect(gradeTemplate(p).at(-1)).toMatchObject({ level: 13, stage: "oberstufe", name: "Qualifikationsphase 2" });
    expect(levelTemplate(p)).toEqual({ sek1: ["E", "G"], oberstufe: ["GK", "LK"] });
  });

  it("Gymnasium G8 in Sachsen: 5–9 + 10/11/12; Berlin beginnt mit 7", () => {
    expect(codes({ state: "SN", form: "gymnasium", oberstufe: false, abitur: "g8" })).toEqual(["5", "6", "7", "8", "9", "10", "11", "12"]);
    expect(gradeTemplate({ state: "SN", form: "gymnasium", oberstufe: false, abitur: "g8" })[5]).toMatchObject({ code: "10", stage: "oberstufe" });
    expect(codes({ state: "BE", form: "gymnasium", oberstufe: true, abitur: "g8" })).toEqual(["7", "8", "9", "10", "11", "12"]);
  });

  it("Realschule und Sekundarschule ohne Oberstufe: bis 10, Landesnamen", () => {
    expect(codes({ state: "BY", form: "realschule", oberstufe: true, abitur: "g9" })).toEqual(["5", "6", "7", "8", "9", "10"]);
    expect(codes({ state: "HH", form: "sekundar", oberstufe: false, abitur: "g9" }).at(-1)).toBe("10");
    expect(formName("sekundar", "HH")).toBe("Stadtteilschule");
    expect(formName("sekundar", "TH")).toBe("Regelschule");
    expect(formName("hauptschule", "BY")).toBe("Mittelschule");
    expect(formName("gymnasium", "NW")).toBe("Gymnasium");
  });
});
