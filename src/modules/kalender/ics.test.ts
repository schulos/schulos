import { describe, expect, it } from "vitest";
import { buildIcs, type IcsEvent } from "./ics";

const base: IcsEvent = {
  id: "ev1",
  title: "Elternabend; Klasse 7b, Raum 112",
  description: "Zeile 1\nZeile 2",
  location: "Raum 112",
  startsAt: new Date("2026-10-13T17:00:00Z"),
  endsAt: new Date("2026-10-13T18:30:00Z"),
  allDay: false,
  repeatWeeklyUntil: null,
  createdAt: new Date("2026-10-01T08:00:00Z"),
};

describe("buildIcs", () => {
  const now = new Date("2026-10-03T10:00:00Z");

  it("erzeugt gültigen Rahmen mit CRLF und escapten Texten", () => {
    const ics = buildIcs("Klasse 7b", [base], now);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261013T170000Z");
    expect(ics).toContain("SUMMARY:Elternabend\\; Klasse 7b\\, Raum 112");
    expect(ics).toContain("DESCRIPTION:Zeile 1\\nZeile 2");
    expect(ics).toContain("UID:ev1@schulos");
  });

  it("ganztägig als DATE (Ende exklusiv)", () => {
    const ics = buildIcs("x", [{ ...base, allDay: true, startsAt: new Date("2026-10-11T22:00:00Z"), endsAt: new Date("2026-10-13T22:00:00Z") }], now);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261012");
    expect(ics).toContain("DTEND;VALUE=DATE:20261014");
  });

  it("Serie als RRULE mit UNTIL", () => {
    const ics = buildIcs("x", [{ ...base, repeatWeeklyUntil: "2026-12-17" }], now);
    expect(ics).toMatch(/RRULE:FREQ=WEEKLY;UNTIL=20261217T230000Z/);
  });

  it("faltet lange Zeilen auf höchstens 75 Oktette", () => {
    const ics = buildIcs("x", [{ ...base, description: "Ä".repeat(100) }], now);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(ics).toContain("\r\n ");
  });
});
