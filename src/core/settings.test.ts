import { afterEach, describe, expect, it } from "vitest";
import { appSettings } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import type { DbHandle } from "@/core/db/client";
import { cachedSchoolSettings, isDemoDb, readSchoolSettings } from "./settings";

let h: DbHandle | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("Einstellungen (B-56: Schuldaten und Demo-Kennzeichen in einer Abfrage)", () => {
  it("liefert Vorgaben ohne Einträge", async () => {
    h = await createTestDb();
    expect(await isDemoDb(h.db)).toBe(false);
    expect((await cachedSchoolSettings(h.db)).name).toBe("SchulOS");
  });

  it("liest Schuldaten und Demo-Kennzeichen wie readSchoolSettings", async () => {
    h = await createTestDb();
    await h.db.insert(appSettings).values([
      { key: "school.name", value: "Gesamtschule am Lindenhof" },
      { key: "school.number", value: 4711 },
      { key: "school.state", value: "BY" },
      { key: "demo", value: true },
    ]);
    expect(await isDemoDb(h.db)).toBe(true);
    const cached = await cachedSchoolSettings(h.db);
    expect(cached).toEqual(await readSchoolSettings(h.db));
    expect(cached).toMatchObject({ name: "Gesamtschule am Lindenhof", number: "4711", profile: { state: "BY" } });
  });
});
