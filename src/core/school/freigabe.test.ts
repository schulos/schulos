import { describe, expect, it } from "vitest";
import { isReleasedState, releaseNote } from "./freigabe";

describe("Freigabe je Bundesland", () => {
  it("nur NRW ist freigegeben, andere Länder bekommen einen Hinweis mit Namen", () => {
    expect(isReleasedState("NW")).toBe(true);
    expect(releaseNote("NW")).toBeNull();
    expect(isReleasedState("BY")).toBe(false);
    expect(releaseNote("BY")).toMatch(/^SchulOS ist derzeit nur für Schulen in Nordrhein-Westfalen freigegeben\. Für Bayern/);
  });
});
