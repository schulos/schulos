import { afterEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { defineSetting, gradeOptions, readGradeSetting, readModuleSetting, readModuleSettings, writeModuleSetting } from "./settings";

const MODE = defineSetting({ key: "x.mode", label: "Modus", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a" });
const GRADE = defineSetting({ key: "x.grade", label: "Jahrgang", options: gradeOptions(5, 10), default: "6" });

let h: DbHandle | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("Moduleinstellungen (Q5-14)", () => {
  it("Jahrgangs-Optionen: aus + bis 5…10", () => {
    expect(gradeOptions(5, 10).map((o) => o.value)).toEqual(["0", "5", "6", "7", "8", "9", "10"]);
    expect(gradeOptions(5, 6)[1]!.label).toBe("bis Jahrgang 5");
  });

  it("liefert ohne Eintrag die Vorgabe, nach dem Speichern den Wert", async () => {
    h = await createTestDb();
    expect(await readModuleSetting(h.db, MODE)).toBe("a");
    expect(await readGradeSetting(h.db, GRADE)).toBe(6);
    await writeModuleSetting(h.db, MODE, "b");
    await writeModuleSetting(h.db, GRADE, "0");
    expect(await readModuleSetting(h.db, MODE)).toBe("b");
    expect(await readGradeSetting(h.db, GRADE)).toBe(0);
    expect(await readModuleSettings(h.db, [MODE, GRADE])).toEqual(new Map([["x.mode", "b"], ["x.grade", "0"]]));
  });

  it("ungültige gespeicherte Werte fallen auf die Vorgabe zurück; ungültige Werte werden nicht gespeichert", async () => {
    h = await createTestDb();
    await h.db.insert(appSettings).values({ key: "module.x.mode", value: "zzz" });
    expect(await readModuleSetting(h.db, MODE)).toBe("a");
    await h.db.insert(appSettings).values({ key: "module.x.grade", value: 8 }); // jsonb-Zahl
    expect(await readModuleSetting(h.db, GRADE)).toBe("8");
    await expect(writeModuleSetting(h.db, MODE, "c")).rejects.toThrow(/Ungültiger Wert/);
  });
});
