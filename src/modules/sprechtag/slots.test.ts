import { describe, expect, it } from "vitest";
import { checkRaster, parseBreaks, slotsFor, suggestSequence } from "./slots";

const raster = { startsAt: "16:00", endsAt: "17:00", slotMinutes: 10, breaks: [] };

describe("Zeitraster", () => {
  it("Gespräche im Takt bis zum Ende", () => {
    expect(slotsFor(raster)).toEqual(["16:00", "16:10", "16:20", "16:30", "16:40", "16:50"]);
    expect(slotsFor({ ...raster, slotMinutes: 15, endsAt: "16:50" })).toEqual(["16:00", "16:15", "16:30"]);
  });

  it("Pausen: was hineinragt, entfällt; danach geht es mit dem Pausenende weiter", () => {
    expect(slotsFor({ ...raster, breaks: [{ from: "16:25", to: "16:35" }] })).toEqual(["16:00", "16:10", "16:35", "16:45"]);
  });

  it("prüft Uhrzeiten, Länge und Pausen", () => {
    expect(checkRaster(raster)).toEqual({});
    expect(checkRaster({ ...raster, endsAt: "15:00" })).toHaveProperty("endsAt");
    expect(checkRaster({ ...raster, slotMinutes: 7 })).toHaveProperty("slotMinutes");
    expect(checkRaster({ ...raster, breaks: parseBreaks("17-16") })).toHaveProperty("breaks");
    expect(parseBreaks("17:30-17:45, 18:00–18:10")).toEqual([
      { from: "17:30", to: "17:45" },
      { from: "18:00", to: "18:10" },
    ]);
  });
});

describe("Vorschlag „hintereinander“", () => {
  const slots = slotsFor(raster);
  const s = (...x: string[]) => new Set(x);

  it("legt Gespräche lückenlos hintereinander, die knappe Lehrkraft zuerst", () => {
    const plan = suggestSequence(slots, [
      { key: "A", free: s("16:00", "16:40", "16:50") },
      { key: "B", free: s("16:20", "16:50") },
      { key: "C", free: s("16:30", "16:40") },
    ]);
    expect(plan).toEqual([
      { key: "B", slot: "16:20" },
      { key: "C", slot: "16:30" },
      { key: "A", slot: "16:40" },
    ]);
  });

  it("umgeht eigene Termine und meldet null, wenn nicht alles passt", () => {
    expect(suggestSequence(slots, [{ key: "A", free: s("16:00", "16:10") }], s("16:00"))).toEqual([{ key: "A", slot: "16:10" }]);
    expect(
      suggestSequence(slots, [
        { key: "A", free: s("16:00") },
        { key: "B", free: s("16:00") },
      ]),
    ).toBeNull();
  });

  it("nimmt bei Lücken die kürzeste Gesamtdauer", () => {
    const plan = suggestSequence(slots, [
      { key: "A", free: s("16:00", "16:40") },
      { key: "B", free: s("16:50") },
    ])!;
    expect(plan.map((p) => p.slot)).toEqual(["16:40", "16:50"]);
  });
});
