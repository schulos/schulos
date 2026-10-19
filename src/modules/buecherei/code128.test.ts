import { describe, expect, it } from "vitest";
import { CODE128_PATTERNS, code128Values, code128Widths } from "./code128";

describe("Code 128 (BU-07)", () => {
  it("Mustertabelle: 107 verschiedene Muster, je 11 Module, Stopp 13", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    const sum = (p: string) => [...p].reduce((a, c) => a + Number(c), 0);
    expect(CODE128_PATTERNS.slice(0, 106).every((p) => p.length === 6 && sum(p) === 11)).toBe(true);
    expect(sum(CODE128_PATTERNS[106]!)).toBe(13);
  });

  it("Start B, Zeichen, Prüfzeichen (gewichtete Summe mod 103), Stopp", () => {
    // „AB“: A = 33, B = 34 → (104 + 33·1 + 34·2) mod 103 = 205 mod 103 = 102
    expect(code128Values("AB")).toEqual([104, 33, 34, 102, 106]);
    expect(code128Values("K-1")).toEqual([104, 43, 13, 17, (104 + 43 + 13 * 2 + 17 * 3) % 103, 106]);
  });

  it("Strichfolge: beginnt mit dem Start-B-Muster, endet mit dem Stopp, Länge 11·(n+3)+2 Module", () => {
    const w = code128Widths("K-7F3Q9XH2MD");
    expect(w.reduce((a, b) => a + b, 0)).toBe(11 * (12 + 3) + 2);
    expect(w.slice(0, 6).join("")).toBe("211214");
    expect(w.slice(-7).join("")).toBe("2331112");
    expect(w.length % 2).toBe(1); // beginnt und endet mit einem Strich
  });

  it("lehnt Nicht-ASCII und leere Texte ab", () => {
    expect(() => code128Values("")).toThrow();
    expect(() => code128Values("Ä")).toThrow();
  });
});
