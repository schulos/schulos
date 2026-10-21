// SP2-03: Tagesgrenzen je Jahrgang in der Demo-Schule – Vorgaben aus dem Katalog, Pflege mit Prüfung, Solver-Eingabe, Diagnose.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableGradeRules } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { diagnoseYear } from "./diagnose";
import { applyGradeRuleDefaults, classGrades, listGradeRules, loadDayLimits, saveGradeRules } from "./jahrgangsregeln";
import { solverInputFromDb } from "./solver-input";
import { planningYear } from "./verteilung";

const today = "2026-10-05";

describe("Tagesgrenzen je Jahrgang (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Demo: Vorgaben der Gesamtschule für die Sek I, der Demo-Plan hält sie ein (Diagnose ohne Verstoß)", async () => {
    const grades = await classGrades(h.db);
    const rules = await listGradeRules(h.db);
    expect(rules.map((r) => r.grade)).toEqual(grades.filter((g) => g <= 10));
    expect(rules.find((r) => r.grade === 5)).toEqual({ grade: 5, maxPerDay: 7, afternoonsPerWeek: 3, lunchAfterPeriod: 6 });
    expect(rules.find((r) => r.grade === 7)).toMatchObject({ maxPerDay: 8, afternoonsPerWeek: 3 });
    const lim = await loadDayLimits(h.db);
    // Zeitraster der Demo hat die Mittagspause nach der 6. Stunde → keine Mittagsstunde, Nachmittag ab der 7.
    const r7 = [...lim.rules.entries()].find(([id]) => lim.gradeOf.get(id) === 7)![1];
    expect(r7).toEqual({ maxPerDay: 8, afternoonsPerWeek: 3, lunchPeriod: null, afternoonFrom: 7 });
    const year = (await planningYear(h.db))!;
    const report = await diagnoseYear(h.db, year, today, 25.5);
    expect(report.findings.filter((f) => f.category === "day")).toEqual([]);
    const input = await solverInputFromDb(h.db, year, today, { seed: 1 });
    expect(input.dayRules?.size).toBe(lim.rules.size);
  }, 120_000);

  it("Pflege: prüft gegen das Zeitraster, leere Angaben löschen die Regel, Vorgaben stellen sie wieder her", async () => {
    await expect(saveGradeRules(h.db, "u-frank.schulte", [{ grade: 7, maxPerDay: 9, afternoonsPerWeek: null, lunchAfterPeriod: null }])).rejects.toMatchObject({
      fieldErrors: { max_7: "Jahrgang 7: 1 bis 8 Stunden" },
    });
    await expect(saveGradeRules(h.db, "u-frank.schulte", [{ grade: 7, maxPerDay: 6, afternoonsPerWeek: 2, lunchAfterPeriod: null }])).rejects.toMatchObject({
      fieldErrors: { pm_7: "Jahrgang 7: Nachmittage brauchen die Angabe „Mittag nach der … Stunde“" },
    });
    await saveGradeRules(h.db, "u-frank.schulte", [{ grade: 7, maxPerDay: null, afternoonsPerWeek: null, lunchAfterPeriod: null }]);
    expect(await h.db.$count(timetableGradeRules, eq(timetableGradeRules.gradeLevel, 7))).toBe(0);
    expect(await h.db.$count(auditLog, eq(auditLog.action, "stundenplan.tagesgrenzen.save"))).toBe(1);
    await applyGradeRuleDefaults(h.db, "u-frank.schulte");
    expect((await listGradeRules(h.db)).find((r) => r.grade === 7)).toMatchObject({ maxPerDay: 8, lunchAfterPeriod: 6, afternoonsPerWeek: 3 });
  }, 120_000);
});
