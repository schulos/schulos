import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { readSchoolSettings } from "@/core/settings";
import { addReduction, defaultObligation, deputyAccounts, setDeputy } from "./deputate";
import { myDeputy, ownSubstitutions } from "./mein-deputat";
import { distribution, planningYear } from "./verteilung";

describe("Mein Deputat (Q5-09)", () => {
  let h: DbHandle;
  const today = "2026-10-07";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableSubstitutions);
    const [jana] = await h.db.select({ id: timetableLessons.id }).from(timetableLessons).where(and(eq(timetableLessons.teacherId, "u-jana.brandt"), eq(timetableLessons.weekday, 0)));
    const [tobias] = await h.db.select({ id: timetableLessons.id }).from(timetableLessons).where(and(eq(timetableLessons.teacherId, "u-tobias.kleine"), eq(timetableLessons.weekday, 0)));
    await h.db.insert(timetableSubstitutions).values([
      // Jana vertritt Tobias (Mehrarbeit), eine eigene Stunde entfällt, eine eigene wird vertreten (Vormonat)
      { lessonId: tobias!.id, date: "2026-10-05", kind: "substitute", substituteId: "u-jana.brandt" },
      { lessonId: jana!.id, date: "2026-10-05", kind: "cancel" },
      { lessonId: jana!.id, date: "2026-09-28", kind: "substitute", substituteId: "u-tobias.kleine" },
      // nur Raumwechsel zählt nicht
      { lessonId: jana!.id, date: "2026-09-21", kind: "room", roomId: "107" },
    ]);
  }, 60_000);
  afterAll(() => h.close());

  it("Vertretungszähler nur der eigenen Person", async () => {
    expect(await ownSubstitutions(h.db, "u-jana.brandt", "2026-08-01", today)).toEqual({ covered: 1, coveredOwnSubject: 0, given: 1, cancelled: 1 });
    expect(await ownSubstitutions(h.db, "u-jana.brandt", "2026-10-01", today)).toEqual({ covered: 1, coveredOwnSubject: 0, given: 0, cancelled: 1 });
    expect(await ownSubstitutions(h.db, "u-tobias.kleine", "2026-08-01", today)).toEqual({ covered: 1, coveredOwnSubject: 0, given: 1, cancelled: 0 });
  });

  it("Konto wie in der Planung, aber nur die eigene Zeile", async () => {
    const year = (await planningYear(h.db))!;
    await addReduction(h.db, "u-admin", { schoolYearId: year.id, teacherId: "u-jana.brandt", reason: "klassenleitung", hours: 1, note: null });
    const mine = (await myDeputy(h.db, "u-jana.brandt", today))!;
    const d = await distribution(h.db, year, today);
    const all = await deputyAccounts(h.db, year.id, d.teachers, defaultObligation((await readSchoolSettings(h.db)).profile.form), d.refYmd);
    expect(mine.account).toEqual(all.find((a) => a.id === "u-jana.brandt"));
    expect(mine.account!.reductions.map((r) => r.reason)).toContain("klassenleitung");
    expect(mine).toMatchObject({ inYear: { covered: 1 }, inMonth: { covered: 1, given: 0 }, monthFrom: "2026-10-01" });
    // keine Daten anderer Personen im Ergebnis
    expect(JSON.stringify(mine)).not.toContain("u-tobias.kleine");
    // Person ohne Unterricht: kein Konto
    expect((await myDeputy(h.db, "u-admin", today))!.account).toBeNull();
  });

  it("SP3-DEP: eigene Rechnung am Stichtag – Teilzeit, Pflicht 2. Halbjahr, Anrechnung ab dem 2. Halbjahr; gleich wie in der Planung", async () => {
    const year = (await planningYear(h.db))!;
    const fallback = defaultObligation((await readSchoolSettings(h.db)).profile.form);
    await setDeputy(h.db, "u-admin", year.id, "u-jana.brandt", { obligation: null, employmentPercent: 80, obligationTerm2: 18 }, fallback);
    await addReduction(h.db, "u-admin", { schoolYearId: year.id, teacherId: "u-jana.brandt", reason: "fachleitung", hours: 2, note: null, validFrom: "2027-02-01" });
    const now = (await myDeputy(h.db, "u-jana.brandt", today))!;
    expect(now.refYmd).toBe(today);
    expect(now.account).toMatchObject({ obligation: 20.5, term: 1, settings: { employmentPercent: 80 }, otherReductions: [{ reason: "fachleitung" }] });
    expect(now.account!.terms?.map((t) => [t.obligation, t.target])).toEqual([
      [20.5, 18.5],
      [18, 14],
    ]);
    const later = (await myDeputy(h.db, "u-jana.brandt", "2027-03-01"))!;
    expect(later.account).toMatchObject({ obligation: 18, term: 2, target: 14 });
    const d = await distribution(h.db, year, "2027-03-01");
    expect(later.account).toEqual((await deputyAccounts(h.db, year.id, d.teachers, fallback, d.refYmd)).find((a) => a.id === "u-jana.brandt"));
  });
});
