import { describe, expect, it } from "vitest";
import { addDays, fromBerlinLocal, fromBerlinLocalStrict, isCalendarDate, isoWeek, mondayOf, toBerlinDate, toBerlinLocal, weekdayMon0 } from "./time";

describe("Zeit (Europe/Berlin)", () => {
  it("GATE-4c: Kalenderdatum streng prüfen (kein Überlauf in den Folgemonat)", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    for (const bad of ["2027-02-29", "2027-02-30", "2027-04-31", "2027-13-01", "2027-00-10", "2027-1-1", "x"]) expect(isCalendarDate(bad), bad).toBe(false);
    expect(fromBerlinLocalStrict("2026-10-05T14:30").toISOString()).toBe("2026-10-05T12:30:00.000Z");
    expect(fromBerlinLocalStrict("2026-10-05").toISOString()).toBe(fromBerlinLocal("2026-10-05").toISOString());
    for (const bad of ["2027-02-30T08:00", "2027-03-01T24:00", "2027-03-01T08:60"]) expect(() => fromBerlinLocalStrict(bad), bad).toThrow(/Ungültige/);
  });
  it("Sommerzeit: 14:30 MESZ = 12:30 UTC", () => {
    expect(fromBerlinLocal("2026-10-05T14:30").toISOString()).toBe("2026-10-05T12:30:00.000Z");
  });
  it("Winterzeit: 14:30 MEZ = 13:30 UTC", () => {
    expect(fromBerlinLocal("2026-12-01T14:30").toISOString()).toBe("2026-12-01T13:30:00.000Z");
  });
  it("Tag der Zeitumstellung (25.10.2026) und reines Datum", () => {
    expect(fromBerlinLocal("2026-10-25T12:00").toISOString()).toBe("2026-10-25T11:00:00.000Z");
    expect(fromBerlinLocal("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });
  it("Rundreise", () => {
    expect(toBerlinLocal(fromBerlinLocal("2027-03-28T09:15"))).toBe("2027-03-28T09:15");
    expect(toBerlinDate(new Date("2026-10-04T23:30:00Z"))).toBe("2026-10-05"); // 01:30 Berlin
  });
  it("Tagesrechnung", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(weekdayMon0("2026-10-05")).toBe(0); // Montag
    expect(mondayOf("2026-10-11")).toBe("2026-10-05"); // Sonntag → Montag davor
  });
});

describe("isoWeek", () => {
  it("rechnet Kalenderwochen nach ISO 8601, auch über den Jahreswechsel", () => {
    expect(isoWeek("2026-10-05")).toBe(41);
    expect(isoWeek("2026-01-01")).toBe(1); // Donnerstag
    expect(isoWeek("2027-01-01")).toBe(53); // Freitag gehört zur KW 53/2026
    expect(isoWeek("2024-12-30")).toBe(1); // Montag gehört zur KW 1/2025
  });
});
