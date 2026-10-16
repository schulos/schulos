import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { addReduction, defaultObligation, deleteReduction, deputyAccounts, reductionKind, setObligation } from "./deputate";
import { distribution, planningYear } from "./verteilung";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Vorgaben", () => {
  it("Pflichtstunden je Schulform, Art der Ermäßigung", () => {
    expect(defaultObligation("gesamtschule")).toBe(25.5);
    expect(defaultObligation("realschule")).toBe(28);
    expect(reductionKind("alter")).toBe("Ermäßigung");
    expect(reductionKind("schulleitung")).toBe("Anrechnung");
  });
});

describe("Deputate (Demo-Schule)", () => {
  let h: DbHandle;
  let yearId: string;
  const today = "2026-10-05";
  const accounts = async () => {
    const year = (await planningYear(h.db))!;
    const d = await distribution(h.db, year, today);
    return deputyAccounts(h.db, year.id, d.teachers, 25.5);
  };
  const of = async (id: string) => (await accounts()).find((a) => a.id === id)!;
  beforeAll(async () => {
    h = await createSeededTestDb();
    yearId = (await planningYear(h.db))!.id;
  });
  afterAll(() => h.close());

  it("Seed: Vorgabe, Teilzeit und Anrechnungen ergeben das Soll; Saldo = Lehraufträge − Soll", async () => {
    const list = await accounts();
    expect(list).toHaveLength(28);
    const lin = list.find((a) => a.id === "u-petra.lindner")!;
    expect(lin).toMatchObject({ obligation: 25.5, isDefault: true, target: 15.5 });
    expect(lin.balance).toBe(lin.assigned - 15.5);
    expect(list.find((a) => a.id === "u-sophie.wagner")).toMatchObject({ obligation: 14, isDefault: false, target: 14 });
    expect(list.find((a) => a.id === "u-tobias.kleine")!.reductions).toEqual([expect.objectContaining({ reason: "koordination", hours: 3, note: "Stufenkoordination 8–10" })]);
  });

  it("Pflichtstunden setzen und zurücksetzen, halbe Stunden erlaubt", async () => {
    await setObligation(h.db, "u-admin", yearId, "u-murat.yilmaz", 20.5);
    expect(await of("u-murat.yilmaz")).toMatchObject({ obligation: 20.5, isDefault: false, target: 20.5 });
    await setObligation(h.db, "u-admin", yearId, "u-murat.yilmaz", 18);
    expect((await of("u-murat.yilmaz")).obligation).toBe(18);
    await setObligation(h.db, "u-admin", yearId, "u-murat.yilmaz", null);
    expect(await of("u-murat.yilmaz")).toMatchObject({ obligation: 25.5, isDefault: true });
    expect(await fieldErrors(setObligation(h.db, "u-admin", yearId, "u-murat.yilmaz", 20.3))).toHaveProperty("obligation");
    expect(await fieldErrors(setObligation(h.db, "u-admin", yearId, "u-murat.yilmaz", 41))).toHaveProperty("obligation");
    expect(await fieldErrors(setObligation(h.db, "u-admin", yearId, "u-lea.schaefer", 10))).toHaveProperty("teacherId");
  });

  it("Ermäßigungen anlegen, prüfen, löschen; Soll nie negativ", async () => {
    const base = { schoolYearId: yearId, teacherId: "u-aylin.demir", reason: "personalrat", hours: 2.5, note: " Vorsitz " };
    const id = await addReduction(h.db, "u-admin", base);
    expect(await of("u-aylin.demir")).toMatchObject({ target: 23, reductions: [{ id, reason: "personalrat", hours: 2.5, note: "Vorsitz" }] });
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, reason: "krankheit" }))).toHaveProperty("reason");
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, hours: 0 }))).toHaveProperty("hours");
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, note: "x".repeat(81) }))).toHaveProperty("note");
    const big = await addReduction(h.db, "u-admin", { ...base, reason: "schulleitung", hours: 30, note: null });
    expect((await of("u-aylin.demir")).target).toBe(0);
    await deleteReduction(h.db, "u-admin", big);
    await deleteReduction(h.db, "u-admin", id);
    expect(await of("u-aylin.demir")).toMatchObject({ target: 25.5, reductions: [] });
  });
});
