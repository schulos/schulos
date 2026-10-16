import { describe, expect, it } from "vitest";
import { NO_STORE_HEADER, noStorePath } from "./no-store";

describe("no-store (P5-12)", () => {
  it("Notenbuch-Seiten und -API ohne Zwischenspeicher, sonst nicht", () => {
    for (const p of ["/notenbuch", "/notenbuch/abc", "/notenbuch/klasse/g-7b", "/api/notenbuch/export"]) expect(noStorePath(p), p).toBe(true);
    for (const p of ["/", "/notenbuchx", "/sitzplan", "/api/notenbuchx", "/api/health"]) expect(noStorePath(p), p).toBe(false);
    expect(NO_STORE_HEADER).toMatch(/no-store/);
  });
});
