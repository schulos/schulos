import { describe, expect, it } from "vitest";
import { checkSchulprofilExport, VORSCHAU_SCHULPROFIL } from "./vorschau";

describe("Q-4E-28: Schulprofil für die Vorschau", () => {
  it("Export grob geprüft und neu formatiert; liegt im Konfigurationsordner der Vorschau (demo-reset liest es)", () => {
    expect(checkSchulprofilExport('{"version":1,"schule":{"name":"X"}}')).toBe(
      '{\n  "version": 1,\n  "schule": {\n    "name": "X"\n  }\n}\n',
    );
    expect(() => checkSchulprofilExport("Fehler: keine DB")).toThrow(
      "keine gültige JSON-Ausgabe",
    );
    expect(() => checkSchulprofilExport("[1]")).toThrow("unerwartetes Format");
    expect(() => checkSchulprofilExport('{"a":1}')).toThrow("ohne „version“");
    expect(VORSCHAU_SCHULPROFIL).toBe("/srv/schulos/config/schulprofil.json");
  });
});
