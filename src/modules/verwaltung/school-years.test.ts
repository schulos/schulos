import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { groups, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { createGroup } from "./groups";
import { addNextSchoolYear, checkSchoolYears, deleteSchoolYear, listSchoolYears, saveSchoolYears, termOf } from "./school-years";
import { ValidationError } from "./users";

const input = (y: { id: string; name: string; startsOn: string; endsOn: string; term2StartsOn: string | null }) => ({ ...y, term2StartsOn: y.term2StartsOn ?? "" });

describe("Stammdaten · Schuljahre", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "u-admin", name: "Admin", email: "admin@test", role: "admin" });
  });
  afterAll(() => h.close());

  it("erstes Schuljahr aus dem heutigen Datum, Folgejahr aus dem letzten", async () => {
    await addNextSchoolYear(h.db, "u-admin", "2026-05-10");
    await addNextSchoolYear(h.db, "u-admin");
    const list = await listSchoolYears(h.db);
    expect(list.map((y) => [y.name, y.startsOn, y.endsOn, y.term2StartsOn, y.isCurrent])).toEqual([
      ["2025/26", "2025-08-01", "2026-07-31", "2026-02-01", true],
      ["2026/27", "2026-08-01", "2027-07-31", "2027-02-01", false],
    ]);
  });

  it("Halbjahr eines Datums", () => {
    const y = { startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: "2027-02-01" };
    expect(termOf(y, "2026-09-01")).toBe(1);
    expect(termOf(y, "2027-02-01")).toBe(2);
    expect(termOf(y, "2027-08-01")).toBeNull();
    expect(termOf({ ...y, term2StartsOn: null }, "2027-05-01")).toBe(1);
  });

  it("prüft Daten, Überschneidungen und doppelte Namen", () => {
    expect(
      checkSchoolYears([
        { id: "a", name: "2026/27", startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: "2027-09-01" },
        { id: "b", name: "2026/27", startsOn: "2027-07-01", endsOn: "2027-02-30", term2StartsOn: "" },
        { id: "c", name: "", startsOn: "2028-08-01", endsOn: "2028-07-01", term2StartsOn: "" },
      ]),
    ).toEqual({
      "term2-a": "Muss innerhalb des Schuljahres liegen",
      "name-b": "Name doppelt",
      "end-b": "Datum angeben",
      "name-c": "Name angeben",
      "end-c": "Ende muss nach dem Beginn liegen",
    });
    expect(
      checkSchoolYears([
        { id: "a", name: "A", startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: "" },
        { id: "b", name: "B", startsOn: "2027-07-15", endsOn: "2028-07-31", term2StartsOn: "" },
      ]),
    ).toEqual({ "start-b": "Überschneidet sich mit A" });
  });

  it("speichert, wechselt das aktuelle Schuljahr, löscht nur unbenutzte", async () => {
    const [a, b] = await listSchoolYears(h.db);
    await expect(saveSchoolYears(h.db, "u-admin", [input(a!), input(b!)], null)).rejects.toBeInstanceOf(ValidationError);
    await saveSchoolYears(h.db, "u-admin", [input(a!), { ...input(b!), term2StartsOn: "2027-01-29" }], b!.id);
    const list = await listSchoolYears(h.db);
    expect(list.map((y) => y.isCurrent)).toEqual([false, true]);
    expect(list[1]!.term2StartsOn).toBe("2027-01-29");

    // neue Klassen hängen am aktuellen Schuljahr
    const gid = await createGroup(h.db, "u-admin", { name: "Klasse 5a", kind: "klasse" });
    const [g] = await h.db.select({ y: groups.schoolYearId }).from(groups);
    expect(g!.y).toBe(b!.id);
    expect(gid).toBeTruthy();

    await expect(deleteSchoolYear(h.db, "u-admin", b!.id)).rejects.toMatchObject({ fieldErrors: { [`name-${b!.id}`]: expect.stringContaining("aktuelle") } });
    await saveSchoolYears(h.db, "u-admin", [input(a!), input(list[1]!)], a!.id);
    await expect(deleteSchoolYear(h.db, "u-admin", b!.id)).rejects.toMatchObject({ fieldErrors: { [`name-${b!.id}`]: "2026/27 hat noch 1 Gruppen" } });
    const c = await addNextSchoolYear(h.db, "u-admin");
    await deleteSchoolYear(h.db, "u-admin", c);
    expect(await listSchoolYears(h.db)).toHaveLength(2);
  });
});
