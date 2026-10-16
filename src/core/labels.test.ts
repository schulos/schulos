import { describe, expect, it } from "vitest";
import { formatLongDate, greeting } from "./labels";

describe("labels", () => {
  it("grüßt nach deutscher Uhrzeit (auch wenn der Server in UTC läuft)", () => {
    expect(greeting(new Date("2026-10-05T06:30:00Z"))).toBe("Guten Morgen"); // 08:30 MESZ
    expect(greeting(new Date("2026-10-05T12:00:00Z"))).toBe("Guten Tag"); // 14:00
    expect(greeting(new Date("2026-10-05T17:30:00Z"))).toBe("Guten Abend"); // 19:30
  });
  it("formatiert das Datum deutsch", () => {
    expect(formatLongDate(new Date("2026-10-05T08:00:00Z"))).toBe("Montag, 5. Oktober");
  });
});
