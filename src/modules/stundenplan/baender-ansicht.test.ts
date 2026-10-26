// Review R3 N4: Band-Ansicht zeitraumunabhängig – Mitglieder aus allen Zeiträumen mit Gültigkeit, Löschen nur ohne Mitglieder.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { bandMembers, freeAssignments, validityLabel } from "./baender-ansicht";
import { createAssignment, createBand, deleteAssignment, deleteBand, listAssignments, listBands, planningYear } from "./verteilung";

const a = (id: string, bandId: string | null, validFrom: string | null = null, validUntil: string | null = null) => ({ id, bandId, validFrom, validUntil });

describe("Band-Ansicht (rein)", () => {
  const all = [a("ganz", "b1"), a("hj2", "b1", "2027-02-01"), a("hj1", "b1", null, "2027-01-31"), a("frei-hj2", null, "2027-02-01"), a("anderes", "b2")];

  it("Mitglieder aus allen Zeiträumen, am Stichtag gültige zuerst, mit Kennzeichen", () => {
    const m = bandMembers("b1", all, "2026-10-05");
    expect(m.map((x) => [x.assignment.id, x.active])).toEqual([
      ["ganz", true],
      ["hj1", true],
      ["hj2", false],
    ]);
  });

  it("ein Band nur mit Mitgliedern des 2. Halbjahrs ist nicht „leer“", () => {
    const m = bandMembers("b1", [a("hj2", "b1", "2027-02-01")], "2026-10-05");
    expect(m).toHaveLength(1);
    expect(m[0]!.active).toBe(false);
  });

  it("frei: alle Lehraufträge ohne Band, auch aus anderen Zeiträumen", () => {
    expect(freeAssignments(all).map((x) => x.id)).toEqual(["frei-hj2"]);
  });

  it("Gültigkeit lesbar", () => {
    expect(validityLabel(a("x", null))).toBeNull();
    expect(validityLabel(a("x", null, "2027-02-01"))).toBe("ab 01.02.2027");
    expect(validityLabel(a("x", null, null, "2027-01-31"))).toBe("bis 31.01.2027");
    expect(validityLabel(a("x", null, "2026-08-01", "2027-01-31"))).toBe("01.08.2026 – 31.01.2027");
  });
});

describe("Band löschen nur ohne Mitglieder (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("onlyEmpty: mit Mitglied (auch nur im 2. Halbjahr) → abgelehnt, Mitglied behält das Band; leer → gelöscht", async () => {
    const year = (await planningYear(h.db))!;
    const bandId = await createBand(h.db, "u-admin", { schoolYearId: year.id, name: "Test-Band N4", hours: 2, doubleLessons: 0 });
    const member = await createAssignment(h.db, "u-admin", {
      schoolYearId: year.id,
      groupId: "g-7b",
      subjectId: "F",
      hours: 2,
      teacherIds: ["u-jana.brandt"],
      doubleLessons: 0,
      roomId: null,
      note: null,
      bandId,
      validFrom: "2027-02-01",
    });
    await expect(deleteBand(h.db, "u-admin", bandId, { onlyEmpty: true })).rejects.toBeInstanceOf(ValidationError);
    expect((await listAssignments(h.db, year.id)).find((x) => x.id === member)?.bandId).toBe(bandId);

    await deleteAssignment(h.db, "u-admin", member);
    await deleteBand(h.db, "u-admin", bandId, { onlyEmpty: true });
    expect((await listBands(h.db, year.id)).some((b) => b.id === bandId)).toBe(false);
  });
});
