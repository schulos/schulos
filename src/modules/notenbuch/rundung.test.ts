// Q-5A-1 (Projektleitung 2026-10-14): Rundung des Halbjahresvorschlags auf der Grenze x,5 als Moduleinstellung je Schule. Ändern
// berechnet die Vorschläge offener Bücher neu; festgelegte Noten bleiben, abgeschlossene Bücher bleiben unverändert.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import {
  appSettings,
  notenbuchTermGrades,
  schoolYears,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { setModuleSetting } from "@/modules/verwaltung/rights";
import manifest from "./manifest";
import { addColumn, createBook, getBook, readRounding, setEntry } from "./service";

const DANIEL = "u-daniel.okafor";
const LEA = "u-lea.schaefer";
const ADMIN = "u-admin";

describe("Notenbuch: Rundung als Einstellung (Q-5A-1)", () => {
  let h: DbHandle;
  let bookId = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAssignments);
    const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const [a] = await h.db
      .insert(timetableAssignments)
      .values({ schoolYearId: year!.id, subjectId: "M", hours: 4 })
      .returning({ id: timetableAssignments.id });
    await h.db.insert(timetableAssignmentGroups).values({ assignmentId: a!.id, groupId: "g-7b" });
    await h.db.insert(timetableAssignmentTeachers).values({ assignmentId: a!.id, teacherId: DANIEL });
    const daniel = await loadPermissions(h.db, DANIEL);
    bookId = await createBook(h.db, daniel, { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten6" }, "2026-10-07");
    const c1 = await addColumn(h.db, daniel, bookId, { kind: "sonstige", title: "Mündlich 1" });
    const c2 = await addColumn(h.db, daniel, bookId, { kind: "sonstige", title: "Mündlich 2" });
    await setEntry(h.db, daniel, { columnId: c1, studentId: LEA, value: "2" });
    await setEntry(h.db, daniel, { columnId: c2, studentId: LEA, value: "3" });
  }, 60_000);
  afterAll(() => h.close());

  const computed = async () =>
    (
      await h.db
        .select()
        .from(notenbuchTermGrades)
        .where(and(eq(notenbuchTermGrades.bookId, bookId), eq(notenbuchTermGrades.studentId, LEA)))
    )[0]?.computed;

  it("Vorgabe zugunsten der Schüler:in; kaufmännisch berechnet offene Bücher neu – auch die Tabelle", async () => {
    expect(await readRounding(h.db)).toBe("schueler");
    expect(await computed()).toBe("2");
    const admin = await loadPermissions(h.db, ADMIN);
    await setModuleSetting(h.db, ADMIN, manifest, "notenbuch.rounding", "kaufmaennisch", admin);
    expect(await readRounding(h.db)).toBe("kaufmaennisch");
    expect(await computed()).toBe("3");
    const view = await getBook(h.db, await loadPermissions(h.db, DANIEL), bookId);
    expect(view?.rounding).toBe("kaufmaennisch");
    expect(view?.results.get(LEA)?.grade).toBe("3");
    await setModuleSetting(h.db, ADMIN, manifest, "notenbuch.rounding", "schueler", admin);
    expect(await computed()).toBe("2");
  });
});
