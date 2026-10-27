import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  addReduction,
  defaultObligation,
  deleteReduction,
  deputyAccounts,
  deputyOn,
  deputyTerms,
  obligationFromPercent,
  reductionActiveOn,
  reductionKind,
  setDeputy,
  termOn,
  type Reduction,
} from "./deputate";
import { diagnoseYear } from "./diagnose";
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

describe("SP3-DEP: Rechnung am Stichtag (rein)", () => {
  const red = (hours: number, validFrom: string | null, validUntil: string | null, id = `r${hours}`): Reduction => ({ id, reason: "koordination", hours, note: null, validFrom, validUntil });
  const year = { startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: "2027-02-01" };

  it("Teilzeit-Rechenhilfe: Vorgabe × Anteil, auf halbe Stunden gerundet", () => {
    expect(obligationFromPercent(25.5, 50)).toBe(13); // 12,75 → 13
    expect(obligationFromPercent(25.5, 55)).toBe(14); // 14,025 → 14
    expect(obligationFromPercent(28, 75)).toBe(21);
    expect(obligationFromPercent(25.5, 60)).toBe(15.5); // 15,3 → 15,5
    expect(obligationFromPercent(25.5, 100)).toBe(25.5);
  });

  it("Gültigkeit einschließlich der Grenzen; Halbjahr ab term2_starts_on", () => {
    const r = red(2, "2026-09-01", "2026-12-31");
    expect(reductionActiveOn(r, "2026-08-31")).toBe(false);
    expect(reductionActiveOn(r, "2026-09-01")).toBe(true);
    expect(reductionActiveOn(r, "2026-12-31")).toBe(true);
    expect(reductionActiveOn(r, "2027-01-01")).toBe(false);
    expect(reductionActiveOn(red(1, null, null), "2027-07-31")).toBe(true);
    expect(termOn("2027-01-31", "2027-02-01")).toBe(1);
    expect(termOn("2027-02-01", "2027-02-01")).toBe(2);
    expect(termOn("2027-05-01", null)).toBe(1);
  });

  it("Pflicht des Halbjahrs, nur geltende Anrechnungen; ohne eigene Angaben unverändert", () => {
    const reds = [red(1, null, null, "a"), red(2, "2027-02-01", null, "b"), red(3, null, "2026-10-31", "c")];
    const s = { obligation: 20, employmentPercent: 80, obligationTerm2: 18 };
    expect(deputyOn(s, reds, 25.5, "2026-10-05", year.term2StartsOn)).toMatchObject({ obligation: 20, isDefault: false, term: 1, target: 16 });
    const t2 = deputyOn(s, reds, 25.5, "2027-03-01", year.term2StartsOn);
    expect(t2).toMatchObject({ obligation: 18, term: 2, target: 15 });
    expect(t2.active.map((r) => r.id)).toEqual(["a", "b"]);
    expect(t2.other.map((r) => r.id)).toEqual(["c"]);
    // nur 2. Halbjahr abweichend, 1. Halbjahr bleibt Vorgabe
    const only2 = { obligation: null, employmentPercent: null, obligationTerm2: 12 };
    expect(deputyOn(only2, [], 25.5, "2026-10-05", year.term2StartsOn)).toMatchObject({ obligation: 25.5, isDefault: true });
    expect(deputyOn(only2, [], 25.5, "2027-02-01", year.term2StartsOn)).toMatchObject({ obligation: 12, isDefault: false });
    // ohne 2. Halbjahr im Schuljahr gilt die Pflicht des 1. Halbjahrs
    expect(deputyOn(s, [], 25.5, "2027-03-01", null)).toMatchObject({ obligation: 20, term: 1 });
    // ohne eigene Angaben und ohne Gültigkeiten: wie vor SP3-DEP
    expect(deputyOn(undefined, [red(3, null, null)], 25.5, "2027-03-01", year.term2StartsOn)).toMatchObject({ obligation: 25.5, isDefault: true, target: 22.5 });
  });

  it("Karte: beide Halbjahre nur, wenn sie sich unterscheiden", () => {
    expect(deputyTerms(undefined, [red(1, null, null)], 25.5, year)).toBeNull();
    expect(deputyTerms({ obligation: 20, employmentPercent: null, obligationTerm2: null }, [], 25.5, year)).toBeNull();
    expect(deputyTerms({ obligation: 20, employmentPercent: null, obligationTerm2: 15 }, [red(1, null, null)], 25.5, year)).toEqual([
      { term: 1, from: "2026-08-01", until: "2027-01-31", obligation: 20, target: 19 },
      { term: 2, from: "2027-02-01", until: "2027-07-31", obligation: 15, target: 14 },
    ]);
    // Anrechnung erst ab dem 2. Halbjahr → Soll unterscheidet sich
    expect(deputyTerms(undefined, [red(2, "2027-02-01", null)], 25.5, year)?.map((t) => t.target)).toEqual([25.5, 23.5]);
    expect(deputyTerms({ obligation: 20, employmentPercent: null, obligationTerm2: 15 }, [], 25.5, { ...year, term2StartsOn: null })).toBeNull();
  });
});

describe("Deputate (Demo-Schule)", () => {
  let h: DbHandle;
  let yearId: string;
  const today = "2026-10-05";
  const term2Day = "2027-03-01";
  const accounts = async (on = today) => {
    const year = (await planningYear(h.db))!;
    const d = await distribution(h.db, year, on);
    return deputyAccounts(h.db, year.id, d.teachers, 25.5, d.refYmd);
  };
  const of = async (id: string, on = today) => (await accounts(on)).find((a) => a.id === id)!;
  const empty = { obligation: null, employmentPercent: null, obligationTerm2: null };
  beforeAll(async () => {
    h = await createSeededTestDb();
    yearId = (await planningYear(h.db))!.id;
  });
  afterAll(() => h.close());

  it("Seed: Vorgabe, Teilzeit und Anrechnungen ergeben das Soll; Saldo = Lehraufträge − Soll", async () => {
    const list = await accounts();
    expect(list).toHaveLength(28);
    const lin = list.find((a) => a.id === "u-petra.lindner")!;
    expect(lin).toMatchObject({ obligation: 25.5, isDefault: true, target: 15.5, term: 1, terms: null });
    expect(lin.balance).toBe(lin.assigned - 15.5);
    expect(list.find((a) => a.id === "u-sophie.wagner")).toMatchObject({ obligation: 14, isDefault: false, target: 14, settings: { obligation: 14, employmentPercent: 55, obligationTerm2: null } });
    expect(list.find((a) => a.id === "u-tobias.kleine")!.reductions).toEqual([expect.objectContaining({ reason: "koordination", hours: 3, note: "Stufenkoordination 8–10", validFrom: null, validUntil: null })]);
    // im 2. Halbjahr rechnet der Seed gleich (keine abweichenden Angaben)
    const later = await accounts(term2Day);
    expect(later.map((a) => [a.id, a.obligation, a.target])).toEqual(list.map((a) => [a.id, a.obligation, a.target]));
  });

  it("Pflichtstunden setzen und zurücksetzen, halbe Stunden erlaubt", async () => {
    await setDeputy(h.db, "u-admin", yearId, "u-murat.yilmaz", { ...empty, obligation: 20.5 }, 25.5);
    expect(await of("u-murat.yilmaz")).toMatchObject({ obligation: 20.5, isDefault: false, target: 20.5 });
    await setDeputy(h.db, "u-admin", yearId, "u-murat.yilmaz", { ...empty, obligation: 18 }, 25.5);
    expect((await of("u-murat.yilmaz")).obligation).toBe(18);
    await setDeputy(h.db, "u-admin", yearId, "u-murat.yilmaz", empty, 25.5);
    expect(await of("u-murat.yilmaz")).toMatchObject({ obligation: 25.5, isDefault: true, settings: empty });
    expect(await fieldErrors(setDeputy(h.db, "u-admin", yearId, "u-murat.yilmaz", { ...empty, obligation: 20.3 }, 25.5))).toHaveProperty("obligation");
    expect(await fieldErrors(setDeputy(h.db, "u-admin", yearId, "u-murat.yilmaz", { ...empty, obligation: 41 }, 25.5))).toHaveProperty("obligation");
    expect(await fieldErrors(setDeputy(h.db, "u-admin", yearId, "u-lea.schaefer", { ...empty, obligation: 10 }, 25.5))).toHaveProperty("teacherId");
  });

  it("SP3-DEP: Teilzeit-Anteil als Rechenhilfe, Pflicht 2. Halbjahr, Prüfungen", async () => {
    const t = "u-murat.yilmaz";
    // nur Anteil → Pflicht = Vorgabe × Anteil, gespeichert wird die Stundenzahl
    await setDeputy(h.db, "u-admin", yearId, t, { ...empty, employmentPercent: 50 }, 25.5);
    expect(await of(t)).toMatchObject({ obligation: 13, isDefault: false, settings: { obligation: 13, employmentPercent: 50, obligationTerm2: null } });
    // eigene Pflicht geht vor, Anteil bleibt als Angabe
    await setDeputy(h.db, "u-admin", yearId, t, { obligation: 12.5, employmentPercent: 50, obligationTerm2: 15 }, 25.5);
    expect(await of(t)).toMatchObject({ obligation: 12.5, term: 1 });
    expect(await of(t, term2Day)).toMatchObject({ obligation: 15, term: 2, target: 15 });
    expect((await of(t)).terms).toEqual([
      { term: 1, from: "2026-08-01", until: "2027-01-31", obligation: 12.5, target: 12.5 },
      { term: 2, from: "2027-02-01", until: "2027-07-31", obligation: 15, target: 15 },
    ]);
    // nur 2. Halbjahr abweichend: 1. Halbjahr bleibt Vorgabe
    await setDeputy(h.db, "u-admin", yearId, t, { ...empty, obligationTerm2: 20 }, 25.5);
    expect(await of(t)).toMatchObject({ obligation: 25.5, isDefault: true });
    expect(await of(t, term2Day)).toMatchObject({ obligation: 20, isDefault: false });
    for (const p of [0, 100.5, 12.34, Number.NaN]) expect(await fieldErrors(setDeputy(h.db, "u-admin", yearId, t, { ...empty, employmentPercent: p }, 25.5))).toHaveProperty("employmentPercent");
    expect(await fieldErrors(setDeputy(h.db, "u-admin", yearId, t, { ...empty, obligationTerm2: 40.5 }, 25.5))).toHaveProperty("obligationTerm2");
    // ohne Beginn des 2. Halbjahrs keine Pflicht fürs 2. Halbjahr
    const [y] = await h.db.select().from(schoolYears).where(eq(schoolYears.id, yearId));
    await h.db.update(schoolYears).set({ term2StartsOn: null }).where(eq(schoolYears.id, yearId));
    try {
      expect(await fieldErrors(setDeputy(h.db, "u-admin", yearId, t, { ...empty, obligationTerm2: 20 }, 25.5))).toHaveProperty("obligationTerm2");
      // Bestand mit Pflicht 2. Hj rechnet ohne Halbjahresbeginn wie das 1. Halbjahr
      expect(await of(t, term2Day)).toMatchObject({ obligation: 25.5, term: 1, terms: null });
    } finally {
      await h.db.update(schoolYears).set({ term2StartsOn: y!.term2StartsOn }).where(eq(schoolYears.id, yearId));
    }
    await setDeputy(h.db, "u-admin", yearId, t, empty, 25.5);
    expect(await of(t, term2Day)).toMatchObject({ obligation: 25.5, isDefault: true });
  });

  it("Ermäßigungen anlegen, prüfen, löschen; Soll nie negativ", async () => {
    const base = { schoolYearId: yearId, teacherId: "u-aylin.demir", reason: "personalrat", hours: 2.5, note: " Vorsitz " };
    const id = await addReduction(h.db, "u-admin", base);
    expect(await of("u-aylin.demir")).toMatchObject({ target: 23, reductions: [{ id, reason: "personalrat", hours: 2.5, note: "Vorsitz", validFrom: null, validUntil: null }] });
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, reason: "krankheit" }))).toHaveProperty("reason");
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, hours: 0 }))).toHaveProperty("hours");
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, note: "x".repeat(81) }))).toHaveProperty("note");
    const big = await addReduction(h.db, "u-admin", { ...base, reason: "schulleitung", hours: 30, note: null });
    expect((await of("u-aylin.demir")).target).toBe(0);
    await deleteReduction(h.db, "u-admin", big);
    await deleteReduction(h.db, "u-admin", id);
    expect(await of("u-aylin.demir")).toMatchObject({ target: 25.5, reductions: [] });
  });

  it("SP3-DEP: Anrechnung mit Gültigkeit zählt nur am Stichtag in ihrem Zeitraum", async () => {
    const base = { schoolYearId: yearId, teacherId: "u-aylin.demir", reason: "fachleitung", hours: 2, note: null };
    const id = await addReduction(h.db, "u-admin", { ...base, validFrom: "2027-02-01", validUntil: null });
    const before = await of("u-aylin.demir");
    expect(before).toMatchObject({ target: 25.5, reductions: [], otherReductions: [{ id, validFrom: "2027-02-01", validUntil: null }] });
    expect(before.terms?.map((t) => t.target)).toEqual([25.5, 23.5]);
    expect(await of("u-aylin.demir", term2Day)).toMatchObject({ target: 23.5, reductions: [{ id }], otherReductions: [] });
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, validFrom: "2026-07-31" }))).toHaveProperty("validFrom");
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, validUntil: "2027-08-01" }))).toHaveProperty("validUntil");
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, validFrom: "2027-03-01", validUntil: "2027-02-01" }))).toHaveProperty("validUntil");
    expect(await fieldErrors(addReduction(h.db, "u-admin", { ...base, validFrom: "01.02.2027" }))).toHaveProperty("validFrom");
    await deleteReduction(h.db, "u-admin", id);
  });

  it("SP3-DEP: Diagnose „Deputat“ rechnet am Stichtag", async () => {
    const t = "u-aylin.demir";
    const year = (await planningYear(h.db))!;
    const [acc, acc2] = [await of(t), await of(t, term2Day)];
    // Pflicht im 2. Halbjahr so, dass genau die Lehraufträge das Soll treffen; im 1. Halbjahr deutlich darüber
    await setDeputy(h.db, "u-admin", yearId, t, { obligation: acc.assigned + 3, employmentPercent: null, obligationTerm2: acc2.assigned }, 25.5);
    try {
      const deputyFor = async (on: string) => (await diagnoseYear(h.db, year, on, 25.5)).findings.filter((f) => f.category === "deputy" && f.target.kind === "teacher" && f.target.id === t);
      expect((await deputyFor(today)).map((f) => f.message)).toEqual([expect.stringContaining("unter Soll")]);
      expect(await deputyFor(term2Day)).toEqual([]);
    } finally {
      await setDeputy(h.db, "u-admin", yearId, t, empty, 25.5);
    }
  });
});
