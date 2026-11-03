import { describe, expect, it } from "vitest";
import { hash, lotOrder } from "./los";
import { lotOrder as kurswahlLotOrder } from "@/modules/kurswahl/zuteilung";

describe("Losreihenfolge (src/core/los.ts, Kurswahl P4-63 und Losverfahren LO-01)", () => {
  it("FNV-1a 32 Bit: bekannte Prüfwerte (Nachrechnen mit anderen Werkzeugen)", () => {
    expect(hash("")).toBe(0x811c9dc5);
    expect(hash("a")).toBe(0xe40c292c);
  });

  it("gleicher Seed und gleiche Kennungen → gleiche Reihenfolge, unabhängig von der Eingabereihenfolge", () => {
    const ids = ["A-2027-0001", "A-2027-0002", "A-2027-0003", "A-2027-0004", "A-2027-0005"];
    const seed = "0123456789abcdef0123456789abcdef";
    // fester Prüfwert: ändert sich der Algorithmus, wären alte Protokolle nicht mehr nachrechenbar
    expect(lotOrder(seed, ids)).toEqual(["A-2027-0005", "A-2027-0004", "A-2027-0003", "A-2027-0002", "A-2027-0001"]);
    expect(lotOrder(seed, [...ids].reverse())).toEqual(lotOrder(seed, ids));
    expect(lotOrder(seed, ids).sort()).toEqual(ids);
    expect(lotOrder("anderer-seed", ids)).not.toEqual(lotOrder(seed, ids));
  });

  it("verändert die Eingabe nicht; die Kurswahl nutzt dieselbe Funktion", () => {
    const ids = ["b", "a", "c"];
    lotOrder("s", ids);
    expect(ids).toEqual(["b", "a", "c"]);
    expect(kurswahlLotOrder).toBe(lotOrder);
  });
});
