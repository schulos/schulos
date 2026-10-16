import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_URL, issueArea, issueHref, issueLink, sourceInfo, sourceLink } from "./source";

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

describe("Problem melden", () => {
  it("Vorgabe: Fehler-Formular im Repo mit Version; eigener Tracker hat Vorrang (nur https)", () => {
    expect(issueLink({ SCHULOS_VERSION: "0.5.3" })).toEqual({ base: `${DEFAULT_SOURCE_URL}/issues/new?template=fehler.yml&version=0.5.3`, withArea: true });
    expect(issueLink({ SCHULOS_ISSUE_URL: "https://tracker.schule.example/neu" })).toEqual({ base: "https://tracker.schule.example/neu", withArea: false });
    expect(issueLink({ SCHULOS_ISSUE_URL: "http://tracker.example" }).withArea).toBe(true);
  });

  it("Bereich ohne IDs und Namen: höchstens zwei Segmente aus Kleinbuchstaben", () => {
    expect(issueArea("/stundenplan")).toBe("/stundenplan");
    expect(issueArea("/verwaltung/benutzer/u-vorname.nachname")).toBe("/verwaltung/benutzer");
    expect(issueArea("/klassenbuch/g-7b/eintrag")).toBe("/klassenbuch");
    expect(issueArea("/gebaeude/pruefarten/extra/tief")).toBe("/gebaeude/pruefarten");
    expect(issueArea("/")).toBe("/");
    expect(issueArea("/notenbuch/0f3a9c2e")).toBe("/notenbuch");
  });

  it("Link mit Bereich nur bei der Vorgabe", () => {
    expect(issueHref({ base: "https://x.example/new?template=fehler.yml&version=1", withArea: true }, "/stundenplan/raeume")).toBe(
      "https://x.example/new?template=fehler.yml&version=1&bereich=%2Fstundenplan%2Fraeume",
    );
    expect(issueHref({ base: "https://t.example/neu", withArea: false }, "/stundenplan")).toBe("https://t.example/neu");
  });
});
