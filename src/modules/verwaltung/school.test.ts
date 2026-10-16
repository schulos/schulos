import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { readSchoolSettings } from "@/core/settings";
import { saveSchoolSettings } from "./school";
import { ValidationError } from "./users";

describe("Schuldaten", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "u-admin", name: "Admin", email: "admin@test", role: "admin" });
  });
  afterAll(() => h.close());

  it("Vorgaben bei leerer DB, speichern, Oberstufe folgt der Schulform", async () => {
    expect((await readSchoolSettings(h.db)).profile).toEqual({ state: "NW", form: "gesamtschule", oberstufe: true, abitur: "g9" });
    await saveSchoolSettings(h.db, "u-admin", { name: "Stadtteilschule Elbblick", number: "4711", color: "#1d4ed8", state: "HH", form: "sekundar", oberstufe: false, abitur: "g9" });
    expect(await readSchoolSettings(h.db)).toEqual({ name: "Stadtteilschule Elbblick", number: "4711", color: "#1D4ED8", profile: { state: "HH", form: "sekundar", oberstufe: false, abitur: "g9" }, logos: {} });
    await saveSchoolSettings(h.db, "u-admin", { name: "Gymnasium am See", number: "", color: "#0e7c66", state: "BY", form: "gymnasium", oberstufe: false, abitur: "g9" });
    expect((await readSchoolSettings(h.db)).profile.oberstufe).toBe(true); // Gymnasium hat immer eine Oberstufe
    await saveSchoolSettings(h.db, "u-admin", { name: "Realschule Nord", number: "", color: "#0e7c66", state: "NI", form: "realschule", oberstufe: true, abitur: "g9" });
    expect((await readSchoolSettings(h.db)).profile.oberstufe).toBe(false);
  });

  it("validiert", async () => {
    try {
      await saveSchoolSettings(h.db, "u-admin", { name: " ", number: "x", color: "rot", state: "XX", form: "uni", oberstufe: false, abitur: "g7" });
      throw new Error("erwartet ValidationError");
    } catch (err) {
      expect(Object.keys((err as ValidationError).fieldErrors).sort()).toEqual(["abitur", "color", "form", "name", "number", "state"]);
    }
  });
});
