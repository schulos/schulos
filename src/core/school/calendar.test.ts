import { describe, expect, it } from "vitest";
import { OPEN_CALENDAR, SchoolCalendar, easterSunday, publicHolidays } from "./calendar";

describe("Schulkalender", () => {
  it("Ostersonntag", () => {
    expect(["2000", "2024", "2026", "2027", "2038"].map((y) => easterSunday(Number(y)))).toEqual(["2000-04-23", "2024-03-31", "2026-04-05", "2027-03-28", "2038-04-25"]);
  });

  it("Feiertage NRW 2026", () => {
    expect(publicHolidays("NW", 2026)).toEqual([
      { date: "2026-01-01", name: "Neujahr" },
      { date: "2026-04-03", name: "Karfreitag" },
      { date: "2026-04-06", name: "Ostermontag" },
      { date: "2026-05-01", name: "Tag der Arbeit" },
      { date: "2026-05-14", name: "Christi Himmelfahrt" },
      { date: "2026-05-25", name: "Pfingstmontag" },
      { date: "2026-06-04", name: "Fronleichnam" },
      { date: "2026-10-03", name: "Tag der Deutschen Einheit" },
      { date: "2026-11-01", name: "Allerheiligen" },
      { date: "2026-12-25", name: "1. Weihnachtstag" },
      { date: "2026-12-26", name: "2. Weihnachtstag" },
    ]);
  });

  it("Landesfeiertage", () => {
    const names = (s: Parameters<typeof publicHolidays>[0], y = 2026) => publicHolidays(s, y).map((h) => h.name);
    expect(names("SN")).toContain("Buß- und Bettag");
    expect(publicHolidays("SN", 2026).find((h) => h.name === "Buß- und Bettag")!.date).toBe("2026-11-18");
    expect(publicHolidays("SN", 2027).find((h) => h.name === "Buß- und Bettag")!.date).toBe("2027-11-17");
    expect(names("BE")).toContain("Internationaler Frauentag");
    expect(names("BE")).not.toContain("Reformationstag");
    expect(names("HH")).toContain("Reformationstag");
    expect(names("BY")).toEqual(expect.arrayContaining(["Heilige Drei Könige", "Fronleichnam", "Allerheiligen"]));
    expect(names("TH")).toContain("Weltkindertag");
    expect(names("SL")).toContain("Mariä Himmelfahrt");
    expect(names("HB")).toHaveLength(10);
  });

  it("Schultage, Ferien schlagen freie Tage, nächster Schultag", () => {
    const cal = new SchoolCalendar("NW", [
      { id: "1", kind: "frei", name: "Pädagogischer Tag", startsOn: "2026-10-16", endsOn: "2026-10-16" },
      { id: "2", kind: "ferien", name: "Herbstferien", startsOn: "2026-10-17", endsOn: "2026-10-31" },
      { id: "3", kind: "frei", name: "Brückentag", startsOn: "2026-10-30", endsOn: "2026-10-30" },
    ]);
    expect(cal.dayOff("2026-10-02")).toBeNull();
    expect(cal.dayOff("2026-10-03")).toEqual({ kind: "feiertag", name: "Tag der Deutschen Einheit", until: "2026-10-03" });
    expect(cal.dayOff("2026-10-30")).toEqual({ kind: "ferien", name: "Herbstferien", until: "2026-10-31" });
    expect(cal.isSchoolDay("2026-10-16")).toBe(false);
    expect(cal.isSchoolDay("2026-10-10")).toBe(false); // Samstag
    expect(cal.nextSchoolDay("2026-10-16")).toBe("2026-11-02");
    expect(cal.nextSchoolDay("2026-10-02")).toBe("2026-10-02");
    expect(cal.between("2026-10-01", "2026-11-01").map((x) => x.name)).toEqual(["Tag der Deutschen Einheit", "Pädagogischer Tag", "Herbstferien", "Brückentag", "Allerheiligen"]);
    expect(OPEN_CALENDAR.isSchoolDay("2026-10-03")).toBe(false); // Samstag bleibt Wochenende
    expect(OPEN_CALENDAR.isSchoolDay("2026-12-25")).toBe(true);
  });
});
