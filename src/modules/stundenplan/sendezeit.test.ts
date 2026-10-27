// VT-04 (F-10-11): reine Zeitlogik der Vertretungsnachricht – Vortags-Uhrzeit, Ruhezeit, heute, rückwirkend, Sommerzeit.
import { describe, expect, it } from "vitest";
import { fromBerlinLocal } from "@/core/time";
import { markerSince } from "./display";
import { DEFAULT_WINDOW, eveOf, inQuietTime, lastEveLocal, outsideQuiet, plannedSendAt, quietEndAfter, type SendWindow } from "./sendezeit";

const at = (local: string) => fromBerlinLocal(local);
const iso = (d: Date) => d.toISOString();
const plan = (date: string, queuedLocal: string, w: SendWindow = DEFAULT_WINDOW) => iso(plannedSendAt(date, at(queuedLocal), w));

describe("VT-04 Sendezeit: Ruhezeit", () => {
  it("über Mitternacht (20:00–06:30), am Tag (12:00–14:00) und „keine Ruhezeit“ (von = bis)", () => {
    expect(inQuietTime("19:59", DEFAULT_WINDOW)).toBe(false);
    expect(inQuietTime("20:00", DEFAULT_WINDOW)).toBe(true);
    expect(inQuietTime("00:00", DEFAULT_WINDOW)).toBe(true);
    expect(inQuietTime("06:29", DEFAULT_WINDOW)).toBe(true);
    expect(inQuietTime("06:30", DEFAULT_WINDOW)).toBe(false);
    const day = { quietFrom: "12:00", quietUntil: "14:00" };
    expect([inQuietTime("11:59", day), inQuietTime("12:00", day), inQuietTime("13:59", day), inQuietTime("14:00", day)]).toEqual([false, true, true, false]);
    expect(inQuietTime("23:00", { quietFrom: "06:30", quietUntil: "06:30" })).toBe(false);
  });

  it("Ende der Ruhezeit: am selben Morgen bzw. am nächsten Morgen", () => {
    expect(iso(quietEndAfter(at("2026-11-03T05:00"), DEFAULT_WINDOW))).toBe("2026-11-03T05:30:00.000Z");
    expect(iso(quietEndAfter(at("2026-11-02T21:00"), DEFAULT_WINDOW))).toBe("2026-11-03T05:30:00.000Z");
    expect(iso(outsideQuiet(at("2026-11-02T10:00"), DEFAULT_WINDOW))).toBe(iso(at("2026-11-02T10:00")));
  });
});

describe("VT-04 Sendezeit: wann geht die Nachricht raus? (Vorgabe 18:00, Ruhe 20:00–06:30, Winterzeit UTC+1)", () => {
  it("morgen: zur Vortags-Uhrzeit; danach sofort; in der Ruhezeit am Ende der Ruhezeit", () => {
    expect(plan("2026-11-03", "2026-11-02T10:00")).toBe("2026-11-02T17:00:00.000Z");
    expect(plan("2026-11-03", "2026-11-02T17:59")).toBe("2026-11-02T17:00:00.000Z");
    expect(plan("2026-11-03", "2026-11-02T18:00")).toBe("2026-11-02T17:00:00.000Z");
    expect(plan("2026-11-03", "2026-11-02T19:00")).toBe("2026-11-02T18:00:00.000Z");
    expect(plan("2026-11-03", "2026-11-02T21:00")).toBe("2026-11-03T05:30:00.000Z");
    expect(plan("2026-11-03", "2026-11-03T00:30")).toBe("2026-11-03T05:30:00.000Z");
  });

  it("heute: sofort, in der Ruhezeit am Ende der Ruhezeit; rückwirkend immer sofort (auch nachts)", () => {
    expect(plan("2026-11-03", "2026-11-03T05:00")).toBe("2026-11-03T05:30:00.000Z");
    expect(plan("2026-11-03", "2026-11-03T10:15")).toBe("2026-11-03T09:15:00.000Z");
    expect(plan("2026-11-03", "2026-11-03T22:00")).toBe("2026-11-04T05:30:00.000Z");
    expect(plan("2026-11-02", "2026-11-03T23:00")).toBe("2026-11-03T22:00:00.000Z");
  });

  it("weiter voraus: am Vortag; über das Wochenende zählt der Kalendertag davor (Montag → Sonntag 18:00)", () => {
    expect(plan("2026-11-06", "2026-11-02T21:00")).toBe("2026-11-05T17:00:00.000Z");
    expect(plan("2026-11-09", "2026-11-06T09:00")).toBe("2026-11-08T17:00:00.000Z");
    expect(iso(eveOf("2026-11-09", DEFAULT_WINDOW))).toBe("2026-11-08T17:00:00.000Z");
  });

  it("eigene Uhrzeiten: Vortags-Uhrzeit in der Ruhezeit → Ende der Ruhezeit; ohne Ruhezeit auch nachts sofort", () => {
    expect(plan("2026-11-06", "2026-11-02T10:00", { eve: "21:00", quietFrom: "20:00", quietUntil: "06:30" })).toBe("2026-11-06T05:30:00.000Z");
    expect(plan("2026-11-03", "2026-11-02T23:00", { eve: "18:00", quietFrom: "06:30", quietUntil: "06:30" })).toBe("2026-11-02T22:00:00.000Z");
    expect(plan("2026-11-03", "2026-11-02T10:00", { eve: "19:30", quietFrom: "22:00", quietUntil: "06:00" })).toBe("2026-11-02T18:30:00.000Z");
  });

  it("Sommerzeit-Umstellung: Ende Oktober (25.10.2026) und Ende März (28.03.2027)", () => {
    // Herbst: Vortag ist der Umstellungstag – 18:00 MEZ = 17:00 UTC; Ruhezeit-Ende am Umstellungsmorgen 06:30 MEZ = 05:30 UTC
    expect(plan("2026-10-26", "2026-10-24T12:00")).toBe("2026-10-25T17:00:00.000Z");
    expect(plan("2026-10-25", "2026-10-24T23:30")).toBe("2026-10-25T05:30:00.000Z");
    // Frühjahr: 18:00 MESZ = 16:00 UTC; Ruhezeit-Ende 06:30 MESZ = 04:30 UTC (die Nacht ist eine Stunde kürzer)
    expect(plan("2027-03-29", "2027-03-27T12:00")).toBe("2027-03-28T16:00:00.000Z");
    expect(plan("2027-03-28", "2027-03-27T22:00")).toBe("2027-03-28T04:30:00.000Z");
    expect(plan("2027-03-28", "2027-03-28T01:30")).toBe("2027-03-28T04:30:00.000Z");
  });

  it("monoton: späteres Einreihen ergibt nie einen früheren Sendezeitpunkt (auch über die Umstellung)", () => {
    for (const date of ["2026-10-26", "2027-03-29", "2026-11-03"]) {
      let last = 0;
      const start = at(`${date}T00:00`).getTime() - 3 * 86_400_000;
      for (let t = start; t < start + 4 * 86_400_000; t += 15 * 60_000) {
        const due = plannedSendAt(date, new Date(t), DEFAULT_WINDOW).getTime();
        expect(due).toBeGreaterThanOrEqual(last);
        expect(due).toBeGreaterThanOrEqual(t);
        last = due;
      }
    }
  });
});

describe("VT-04 Marker-Stichzeit aus der Vortags-Uhrzeit bzw. dem tatsächlichen Versand", () => {
  it("letzter Vortags-Termin vor jetzt, mit eingestellter Uhrzeit", () => {
    expect(lastEveLocal("2026-10-05T17:59", "18:00")).toBe("2026-10-04T18:00");
    expect(lastEveLocal("2026-10-05T19:30", "19:30")).toBe("2026-10-05T19:30");
    expect(lastEveLocal("2026-11-01T06:00", "17:00")).toBe("2026-10-31T17:00");
  });

  it("der tatsächliche Versand zählt, wenn er nach dem Termin und vor jetzt liegt", () => {
    const now = at("2026-11-03T10:00");
    expect(markerSince(now, { eve: "18:00" }).label).toBe("seit gestern, 18:00 Uhr");
    const m = markerSince(now, { eve: "18:00", dispatched: at("2026-11-02T18:03") });
    expect(m.label).toBe("seit gestern, 18:03 Uhr");
    expect(iso(m.since)).toBe("2026-11-02T17:03:00.000Z");
    expect(markerSince(now, { eve: "18:00", dispatched: at("2026-11-02T17:00") }).label).toBe("seit gestern, 18:00 Uhr");
    expect(markerSince(at("2026-11-03T19:00"), { eve: "18:30" }).label).toBe("seit heute, 18:30 Uhr");
  });
});
