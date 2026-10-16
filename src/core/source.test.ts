import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_URL, sourceInfo, sourceLink } from "./source";

describe("Quellcode-Hinweis (AGPL § 13, Q-4E-31)", () => {
  it("Release: Link auf den Tag der laufenden Version", () => {
    expect(sourceInfo({ SCHULOS_VERSION: "0.5.1" })).toEqual({ href: `${DEFAULT_SOURCE_URL}/tree/v0.5.1`, version: "0.5.1" });
    expect(sourceInfo({ SCHULOS_VERSION: "0.6.0-rc.1" }).href).toBe(`${DEFAULT_SOURCE_URL}/tree/v0.6.0-rc.1`);
  });

  it("Entwicklung: Link auf das Repo", () => {
    expect(sourceInfo({})).toEqual({ href: DEFAULT_SOURCE_URL, version: "dev" });
  });

  it("eigene Fassung: SCHULOS_SOURCE_URL hat Vorrang", () => {
    expect(sourceInfo({ SCHULOS_VERSION: "0.5.1", SCHULOS_SOURCE_URL: "https://git.schule.example/schulos/" }).href).toBe("https://git.schule.example/schulos");
  });

  it("ungültige Adresse (kein https, mit Zugangsdaten, Unsinn) → Vorgabe statt kein Hinweis", () => {
    for (const bad of ["http://git.example/x", "https://user:pw@git.example/x", "javascript:alert(1)", "kein link"])
      expect(sourceInfo({ SCHULOS_SOURCE_URL: bad }).href).toBe(DEFAULT_SOURCE_URL);
  });

  it("Version wird für die Anzeige bereinigt", () => {
    expect(sourceInfo({ SCHULOS_VERSION: "1.0.0<script>" }).version).toBe("1.0.0script");
  });

  it("Shell bekommt eine fertige Beschriftung (kein Feld „version“ in der Antwort)", () => {
    expect(sourceLink({ SCHULOS_VERSION: "0.5.1" })).toEqual({ href: `${DEFAULT_SOURCE_URL}/tree/v0.5.1`, label: "Quellcode (AGPL) · 0.5.1" });
  });
});
