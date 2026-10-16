import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { gradeLevels } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { listUsers } from "@/modules/verwaltung/users";
import { sek1GradeOf, withinGradeSetting } from "./grades";

describe("Jahrgang für die Jahrgangs-Schalter (Q5-02/Q5-03)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Schalter: 0 = aus, sonst bis einschließlich Jahrgang", () => {
    expect(withinGradeSetting(7, 0)).toBe(false);
    expect(withinGradeSetting(7, 7)).toBe(true);
    expect(withinGradeSetting(8, 7)).toBe(false);
    expect(withinGradeSetting(undefined, 10)).toBe(false);
  });

  it("Sek I aus der Klasse; Oberstufe fehlt – auch wenn ihr Jahrgang eine kleine Zahl hat (G8: EF = 10)", async () => {
    const [q1] = (await listUsers(h.db, { groupId: "g-q1", role: "schueler" })).rows;
    const [tenth] = (await listUsers(h.db, { groupId: "g-10a", role: "schueler" })).rows;
    const grades = await sek1GradeOf(h.db, ["u-lea.schaefer", q1!.id, tenth!.id, "u-jana.brandt"]);
    expect(grades.get("u-lea.schaefer")).toBe(7);
    expect(grades.get(tenth!.id)).toBe(10);
    expect(grades.has(q1!.id)).toBe(false);
    expect(grades.has("u-jana.brandt")).toBe(false); // Klassenleitung ist Leitung, nicht Mitglied
    await h.db.update(gradeLevels).set({ stage: "oberstufe" }).where(eq(gradeLevels.level, 10));
    expect((await sek1GradeOf(h.db, [tenth!.id])).has(tenth!.id)).toBe(false);
    expect(await sek1GradeOf(h.db, [])).toEqual(new Map());
  });
});
