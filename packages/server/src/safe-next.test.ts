import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext (SEC-04)", () => {
  it("lässt Pfade derselben Seite samt Suche und Anker durch", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/passwort")).toBe("/passwort");
    expect(safeNext("/kalender?tag=2026-10-10#heute")).toBe("/kalender?tag=2026-10-10#heute");
    expect(safeNext("/dateien/a%20b")).toBe("/dateien/a%20b");
  });

  it("weist fremde Ziele ab", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/ /evil.example",
      "/%5Cevil.example",
      "/%2F/evil.example",
      "https://evil.example",
      "evil.example",
      "javascript:alert(1)",
      "",
    ]) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe("/");
    }
  });

  it("verträgt fehlende und falsche Typen", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(42)).toBe("/");
  });
});
