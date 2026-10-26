// Schulbücherei – Rückgabetag der Schulbücher je Schuljahr (BU-14): Vorgabe Schuljahresende, eingestellter Tag steuert Fälligkeit
// der Ausgabe (neu und bereits ausgegeben) und den Mahnlauf, Prüfungen, Rechte, Schalter, Hinweis für „Meine Ausleihen“.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buechereiMaterialIssues } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { issueCopy, runSchoolbookDunning, schoolbooksOf } from "./ausgabe";
import { dueDate } from "./dates";
import { currentReturnDay, customReturnDay, effectiveReturnDay, returnDayOf, setReturnDay } from "./einstellungen";
import { createMaterial } from "./lernmittel";
import { LERNMITTEL } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: `buecherei.materials`
const AYLIN = "u-aylin.demir"; // Büchereiteam
const LEA = "u-lea.schaefer";
const JANA = "u-jana.brandt";

const fails = (pr: Promise<unknown>, re: RegExp) =>
  expect(pr).rejects.toSatisfy((e: unknown) => e instanceof ValidationError && re.test(Object.values(e.fieldErrors).join(" | ")));

describe("Rückgabetag der Schulbücher (BU-14)", () => {
  let h: DbHandle;
  let day: string;
  let numbers: string[];
  let yearId: string;
  let endsOn: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    day = await dueDate(h.db, "2026-11-09", 0);
    const cur = (await currentReturnDay(h.db))!;
    yearId = cur.yearId;
    endsOn = cur.endsOn;
    ({ numbers } = await createMaterial(h.db, await p(SABINE), { title: "Rückgabetag-Probe", grades: [7], provision: "leihe" }, { count: 4 }));
  });
  afterAll(async () => {
    await h.close();
  });

  it("rein: eingestellter Tag, sonst Schuljahresende", () => {
    expect(effectiveReturnDay(null, "2027-07-31")).toBe("2027-07-31");
    expect(effectiveReturnDay("2027-06-25", "2027-07-31")).toBe("2027-06-25");
  });

  it("Vorgabe: leer = Schuljahresende, die Ausgabe ist dann dort fällig", async () => {
    expect(await customReturnDay(h.db, yearId)).toBeNull();
    expect(await currentReturnDay(h.db)).toMatchObject({ day: endsOn, custom: false, yearName: "2026/27" });
    expect(await returnDayOf(h.db, { id: yearId, endsOn })).toBe(endsOn);
    const r = await issueCopy(h.db, await p(SABINE), LEA, numbers[0]!, day);
    expect(r.dueOn).toBe(endsOn);
  });

  it("eingestellter Tag: gilt für neue und bereits ausgegebene Schulbücher, steht in „Meine Ausleihen“", async () => {
    const s = await p(SABINE);
    const tag = addDays(day, 60);
    await setReturnDay(h.db, s, yearId, tag, day);
    expect(await customReturnDay(h.db, yearId)).toBe(tag);
    expect(await currentReturnDay(h.db)).toMatchObject({ day: tag, custom: true });
    // bereits ausgegeben
    expect((await schoolbooksOf(h.db, LEA, day))[0]!.dueOn).toBe(tag);
    // neu ausgegeben
    expect((await issueCopy(h.db, s, JANA, numbers[1]!, day)).dueOn).toBe(tag);
    // zurück auf leer → Schuljahresende
    await setReturnDay(h.db, s, yearId, "", day);
    expect(await customReturnDay(h.db, yearId)).toBeNull();
    expect((await schoolbooksOf(h.db, JANA, day))[0]!.dueOn).toBe(endsOn);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "buecherei.material.return_day"))).length).toBe(2);
  });

  it("Mahnlauf richtet sich nach dem Rückgabetag; wird er verschoben, beginnt die Mahnung von vorn", async () => {
    const s = await p(SABINE);
    const tag = addDays(day, 1);
    await setReturnDay(h.db, s, yearId, tag, day);
    const later = await dueDate(h.db, addDays(tag, 2), 0); // ein Schultag nach dem Rückgabetag
    expect(later > tag).toBe(true);
    expect((await runSchoolbookDunning(h.db, day, { mail: false, school: "Testschule" })).dunned).toBe(0); // noch nicht fällig
    const r = await runSchoolbookDunning(h.db, later, { mail: false, school: "Testschule" });
    expect(r.dunned).toBeGreaterThanOrEqual(2);
    const open = () => h.db.select().from(buechereiMaterialIssues).where(and(eq(buechereiMaterialIssues.schoolYearId, yearId), inArray(buechereiMaterialIssues.userId, [LEA, JANA]))).orderBy(buechereiMaterialIssues.userId);
    expect((await open()).map((i) => i.dunningLevel)).toEqual([1, 1]);
    // Rückgabetag nach hinten → fällig erst später, Mahnstufe zurückgesetzt
    await setReturnDay(h.db, s, yearId, addDays(later, 30), later);
    expect((await open()).map((i) => [i.dunningLevel, i.dunnedOn])).toEqual([
      [0, null],
      [0, null],
    ]);
    expect((await runSchoolbookDunning(h.db, later, { mail: false, school: "Testschule" })).dunned).toBe(0);
  });

  it("Prüfungen, Rechte und Schalter", async () => {
    const s = await p(SABINE);
    await fails(setReturnDay(h.db, s, yearId, "25.06.2027", day), /Datum/);
    await fails(setReturnDay(h.db, s, yearId, "2027-02-30", day), /Datum/);
    await fails(setReturnDay(h.db, s, yearId, addDays(day, -1), day), /Vergangenheit/);
    await fails(setReturnDay(h.db, s, yearId, addDays(endsOn, 1), day), /Schuljahresende/);
    await fails(setReturnDay(h.db, s, "gibtsnicht", day, day), /Schuljahr/);
    await expect(setReturnDay(h.db, await p(AYLIN), yearId, "", day)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setReturnDay(h.db, await p(LEA), yearId, "", day)).rejects.toBeInstanceOf(ForbiddenError);
    await writeModuleSetting(h.db, LERNMITTEL, "0");
    try {
      await fails(setReturnDay(h.db, s, yearId, "", day), /ausgeschaltet/);
    } finally {
      await writeModuleSetting(h.db, LERNMITTEL, "1");
    }
  });
});
