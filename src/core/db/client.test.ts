import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "./client";
import { appSettings } from "./schema";
import { createTestDb } from "./testing";

describe("DB-Schicht (In-Memory-PGlite)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it("schreibt und liest über die migrierte Tabelle", async () => {
    await h.db.insert(appSettings).values({ key: "schoolName", value: "Gesamtschule am Lindenhof" });
    const rows = await h.db.select().from(appSettings).where(eq(appSettings.key, "schoolName"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("Gesamtschule am Lindenhof");
  });

  it("hält jede Test-DB isoliert", async () => {
    const other = await createTestDb();
    // nur die Vorgabe aus Migration 0078 (Stichtag der 2FA-Pflicht), nichts aus der anderen DB
    const rows = await other.db.select().from(appSettings);
    expect(rows.map((r) => r.key)).toEqual(["sicherheit.zwei_faktor_ab"]);
    await other.close();
  });
});
