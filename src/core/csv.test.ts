import { describe, expect, it } from "vitest";
import { csvBytes, csvCell, decodeCsvBytes, detectSeparator, encodeCp1252, splitCsvLine, toCsv } from "./csv";

describe("CSV-Helfer", () => {
  it("entschärft Formeln und setzt Anführungszeichen nur bei Bedarf", () => {
    expect(["=1+1", "+49 170", "-2", "@SUMME(A1)", "\tx", "\rx", "normal", 'a"b;c', "Zeile\nzwei"].map(csvCell)).toEqual([
      "'=1+1",
      "'+49 170",
      "'-2",
      "'@SUMME(A1)",
      "'\tx",
      "\"'\rx\"",
      "normal",
      '"a""b;c"',
      '"Zeile\nzwei"',
    ]);
  });

  it("ganze Datei: BOM, Semikolon, CRLF, leere Werte", () => {
    expect(toCsv([["a", 1, null], ["=x", undefined, "ü"]])).toBe("﻿a;1;\r\n'=x;;ü\r\n");
  });

  it("Kodierung: UTF-8 mit BOM oder Windows-1252 ohne BOM, Unbekanntes wird „?“", () => {
    expect([...encodeCp1252("﻿Ä;ß;€;„x“;ł\r\n")]).toEqual([0xc4, 0x3b, 0xdf, 0x3b, 0x80, 0x3b, 0x84, 0x78, 0x93, 0x3b, 0x3f, 0x0d, 0x0a]);
    expect([...csvBytes([["ü"]], "utf8")]).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xbc, 0x0d, 0x0a]);
    expect([...csvBytes([["ü"]], "cp1252")]).toEqual([0xfc, 0x0d, 0x0a]);
  });

  it("Lesen: UTF-8 (mit/ohne BOM) bleibt UTF-8, sonst Windows-1252 (SP2-06)", () => {
    expect(decodeCsvBytes(csvBytes([["Müller", "€"]], "utf8"))).toEqual({ text: "Müller;€\r\n", encoding: "utf8" });
    expect(decodeCsvBytes(new TextEncoder().encode("Größe"))).toEqual({ text: "Größe", encoding: "utf8" });
    expect(decodeCsvBytes(csvBytes([["Müller", "€", "„x“"]], "cp1252"))).toEqual({ text: "Müller;€;„x“\r\n", encoding: "cp1252" });
  });

  it("Zeilen zerlegen mit Anführungszeichen; Trennzeichen erkennen", () => {
    expect(splitCsvLine('a; "b;c" ;"d""e"', ";")).toEqual(["a", "b;c", 'd"e']);
    expect(detectSeparator("a,b,c\nx;y")).toBe(",");
    expect(detectSeparator("\n\na;b,c")).toBe(";");
  });
});
