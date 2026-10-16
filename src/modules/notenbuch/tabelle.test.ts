// Notenbuch (P5-12): Notentabelle im Service – Spalten bearbeiten/löschen/umsortieren, Gewichte, Neuberechnung des ganzen
// Buchs, Spalte aus dem Klausurplan, Versionsprüfung (Konflikt), Fehlstunden nur aus eigenen Stunden; Rechte (fremde Lehrkraft,
// Admin `*`, Klassenleitung ohne Teilnoten) und gesperrtes Buch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import {
  appSettings,
  auditLog,
  classbookAbsences,
  classbookEntries,
  exams,
  grants,
  notenbuchBooks,
  notenbuchColumns,
  notenbuchTermGrades,
  schoolYears,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import {
  addColumn,
  addColumnFromExam,
  createBook,
  deleteColumn,
  EntryConflictError,
  examOptions,
  getBook,
  moveColumn,
  ownAbsenceCounts,
  setEntry,
  setWeights,
  termOverview,
  termRange,
  updateColumn,
} from "./service";

const TODAY = "2026-10-07";
const JANA = "u-jana.brandt"; // Klassenleitung 7b
const TOBIAS = "u-tobias.kleine"; // Mathe 7b (Teamteaching)
const DANIEL = "u-daniel.okafor"; // Mathe 7b (Teamteaching)
const MURAT = "u-murat.yilmaz"; // fremde Lehrkraft
const ADMIN = "u-admin";
const LEA = "u-lea.schaefer"; // Schülerin 7b

describe("Notenbuch: Notentabelle (P5-12)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let bookId = "";
  let other = ""; // zweite Person der 7b
  let ka = ""; // Spalte Klassenarbeit (Punkte)
  let muendlich = ""; // Spalte mündlich (Noten)

  const term = async (studentId: string) =>
    (await h.db.select().from(notenbuchTermGrades).where(and(eq(notenbuchTermGrades.bookId, bookId), eq(notenbuchTermGrades.studentId, studentId))))[0];

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAssignments);
    await h.db.delete(exams);
    await h.db.delete(classbookEntries);
    const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const [a] = await h.db.insert(timetableAssignments).values({ schoolYearId: year!.id, subjectId: "M", hours: 4 }).returning({ id: timetableAssignments.id });
    await h.db.insert(timetableAssignmentGroups).values({ assignmentId: a!.id, groupId: "g-7b" });
    await h.db.insert(timetableAssignmentTeachers).values([
      { assignmentId: a!.id, teacherId: DANIEL },
      { assignmentId: a!.id, teacherId: TOBIAS },
    ]);
    bookId = await createBook(h.db, await p(DANIEL), { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten6" }, TODAY);
    const view = (await getBook(h.db, await p(DANIEL), bookId))!;
    other = view.students.find((s) => s.id !== LEA)!.id;
  }, 60_000);
  afterAll(() => h.close());

  it("Halbjahr des Buchs: 1. Halbjahr bis zum Tag vor `term2_starts_on`", async () => {
    expect(await termRange(h.db, { schoolYearId: "sj-2026-27", term: 1 })).toEqual({ from: "2026-08-01", to: "2027-01-31" });
    expect(await termRange(h.db, { schoolYearId: "sj-2026-27", term: 2 })).toEqual({ from: "2027-02-01", to: "2027-07-31" });
  });

  it("Spalten anlegen, Noten eintragen; Konflikt bei veralteter Version", async () => {
    const daniel = await p(DANIEL);
    ka = await addColumn(h.db, daniel, bookId, { kind: "schriftlich", title: "1. Klassenarbeit", maxPoints: 40 });
    muendlich = await addColumn(h.db, daniel, bookId, { kind: "sonstige", title: "Mündlich September" });
    expect(await setEntry(h.db, daniel, { columnId: ka, studentId: LEA, value: "34", expectedVersion: 0 })).toBeGreaterThan(0); // 85 % → 1
    const vMuendlich = await setEntry(h.db, daniel, { columnId: muendlich, studentId: LEA, value: "3", expectedVersion: 0 });
    expect(vMuendlich).toBeGreaterThan(0);
    expect(await setEntry(h.db, daniel, { columnId: ka, studentId: other, value: "20" })).toBeGreaterThan(0); // 50 % → 4
    expect((await term(LEA))!.computed).toBe("2"); // (1 + 3) / 2
    // zweite Lehrkraft mit veralteter Version: abgelehnt, Wert bleibt
    const err = await setEntry(h.db, await p(TOBIAS), { columnId: muendlich, studentId: LEA, value: "1", expectedVersion: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntryConflictError);
    expect((await getBook(h.db, daniel, bookId))!.entries.get(`${muendlich}:${LEA}`)).toMatchObject({ value: "3", version: vMuendlich });
  });

  it("Gewichte ändern berechnet das ganze Buch neu – auch eine Summe ≠ 100 ist erlaubt", async () => {
    const daniel = await p(DANIEL);
    await expect(setWeights(h.db, daniel, bookId, { schriftlich: 0, sonstige: 0 })).rejects.toMatchObject({ fieldErrors: { weights: /Mindestens/ } });
    await expect(setWeights(h.db, daniel, bookId, { schriftlich: 101, sonstige: 0 })).rejects.toMatchObject({ fieldErrors: { weights: /0 bis 100/ } });
    await setWeights(h.db, daniel, bookId, { schriftlich: 75, sonstige: 50 }); // 60 : 40 → 1·0,6 + 3·0,4 = 1,8 → 2
    expect((await term(LEA))!.computed).toBe("2");
    await setWeights(h.db, daniel, bookId, { schriftlich: 100, sonstige: 0 });
    expect((await term(LEA))!.computed).toBe("1");
    expect((await term(other))!.computed).toBe("4");
    const [b] = await h.db.select({ weights: notenbuchBooks.weights }).from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId));
    expect(b!.weights).toEqual({ schriftlich: 100, sonstige: 0 });
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.gewichte"))).toHaveLength(2);
  });

  it("Notenschlüssel ändern berechnet neu; Wechsel Punkte ↔ Noten nur bei leerer Spalte", async () => {
    const daniel = await p(DANIEL);
    // strenger Schlüssel: 1 erst ab 90 % → Lea (85 %) bekommt 2
    const key = [
      { grade: "1", min: 90 },
      { grade: "2", min: 75 },
      { grade: "3", min: 60 },
      { grade: "4", min: 45 },
      { grade: "5", min: 20 },
      { grade: "6", min: 0 },
    ];
    await updateColumn(h.db, daniel, ka, { kind: "schriftlich", title: "1. Klassenarbeit", maxPoints: 40, key });
    expect((await term(LEA))!.computed).toBe("2");
    expect((await term(other))!.computed).toBe("4");
    await expect(updateColumn(h.db, daniel, ka, { kind: "schriftlich", title: "KA", maxPoints: null })).rejects.toMatchObject({ fieldErrors: { maxPoints: /Punkten und Noten/ } });
    await expect(updateColumn(h.db, daniel, ka, { kind: "schriftlich", title: "KA", maxPoints: 30 })).rejects.toMatchObject({ fieldErrors: { maxPoints: /über der neuen/ } });
    await expect(updateColumn(h.db, daniel, ka, { kind: "schriftlich", title: "KA", maxPoints: 40, key: [{ grade: "1", min: 50 }] })).rejects.toMatchObject({ fieldErrors: { key: /0 %/ } });
    await expect(updateColumn(h.db, daniel, ka, { kind: "x", title: "" })).rejects.toMatchObject({ fieldErrors: { kind: /Art/, title: /Titel/ } });
    // Gewicht 0 → Spalte zählt nicht
    await updateColumn(h.db, daniel, ka, { kind: "schriftlich", title: "1. Klassenarbeit", maxPoints: 40, key, weight: 0 });
    expect((await term(LEA))!.computed).toBeNull();
    await updateColumn(h.db, daniel, ka, { kind: "schriftlich", title: "1. Klassenarbeit", maxPoints: 40, key: null, weight: 100 });
    expect((await term(LEA))!.computed).toBe("1");
  });

  it("Spalten umsortieren und löschen (mit Neuberechnung)", async () => {
    const daniel = await p(DANIEL);
    const third = await addColumn(h.db, daniel, bookId, { kind: "sonstige", title: "Referat" });
    const order = async () => (await getBook(h.db, daniel, bookId))!.columns.map((c) => c.id);
    expect(await order()).toEqual([ka, muendlich, third]);
    await moveColumn(h.db, daniel, third, -1);
    expect(await order()).toEqual([ka, third, muendlich]);
    await moveColumn(h.db, daniel, ka, -1); // schon ganz links – bleibt
    await moveColumn(h.db, daniel, ka, 1);
    expect(await order()).toEqual([third, ka, muendlich]);
    await expect(moveColumn(h.db, daniel, ka, 2)).rejects.toMatchObject({ fieldErrors: { direction: /Richtung/ } });
    await setWeights(h.db, daniel, bookId, { schriftlich: 50, sonstige: 50 });
    expect((await term(LEA))!.computed).toBe("2");
    await deleteColumn(h.db, daniel, ka);
    expect(await order()).toEqual([third, muendlich]);
    expect((await term(LEA))!.computed).toBe("3"); // nur noch mündlich
    expect((await term(other))!.computed).toBeNull();
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.spalte.loeschen"));
    expect(log).toMatchObject({ actorId: DANIEL, target: bookId, meta: { column: ka, eintraege: 2 } });
    await deleteColumn(h.db, daniel, third);
  });

  it("Spalte aus dem Klausurplan: nur Termine der Gruppe im Fach und Halbjahr, jeder nur einmal", async () => {
    const [mine, otherSubject, otherTerm] = await h.db
      .insert(exams)
      .values([
        { groupId: "g-7b", subjectId: "M", kind: "klassenarbeit", title: "2. Klassenarbeit", date: "2026-11-12", periodFrom: 1, periodTo: 2, teacherId: DANIEL },
        { groupId: "g-7b", subjectId: "D", kind: "klassenarbeit", title: "Deutsch-Arbeit", date: "2026-11-13", periodFrom: 1, periodTo: 2, teacherId: JANA },
        { groupId: "g-7b", subjectId: "M", kind: "klassenarbeit", title: "3. Klassenarbeit", date: "2027-03-10", periodFrom: 1, periodTo: 2, teacherId: DANIEL },
      ])
      .returning({ id: exams.id });
    const daniel = await p(DANIEL);
    expect((await examOptions(h.db, daniel, bookId)).map((e) => e.id)).toEqual([mine!.id]);
    await expect(addColumnFromExam(h.db, daniel, bookId, otherSubject!.id)).rejects.toMatchObject({ fieldErrors: { examId: /Klausurplan/ } });
    await expect(addColumnFromExam(h.db, daniel, bookId, otherTerm!.id)).rejects.toMatchObject({ fieldErrors: { examId: /Klausurplan/ } });
    const col = await addColumnFromExam(h.db, daniel, bookId, mine!.id);
    const [c] = await h.db.select().from(notenbuchColumns).where(eq(notenbuchColumns.id, col));
    expect(c).toMatchObject({ kind: "schriftlich", title: "2. Klassenarbeit", date: "2026-11-12", examId: mine!.id, weight: 100 });
    expect(await examOptions(h.db, daniel, bookId)).toEqual([]);
    await expect(addColumnFromExam(h.db, daniel, bookId, mine!.id)).rejects.toMatchObject({ fieldErrors: { examId: /schon übernommen/ } });
    // fremde Lehrkraft sieht keine Termine und kann nichts übernehmen
    expect(await examOptions(h.db, await p(MURAT), bookId)).toEqual([]);
    await expect(addColumnFromExam(h.db, await p(MURAT), bookId, mine!.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Fehlstunden nur aus eigenen Stunden der Lehrkraft (Gruppe, Fach, Halbjahr), nur „fehlt“", async () => {
    const entry = (teacherId: string, subjectId: string, date: string, periodNr: number) => ({ groupId: "g-7b", subjectId, teacherId, date, periodNr, topic: "Thema" });
    const rows = await h.db
      .insert(classbookEntries)
      .values([
        entry(DANIEL, "M", "2026-09-01", 1), // eigene Stunde
        entry(DANIEL, "M", "2026-09-02", 1), // eigene Stunde
        entry(TOBIAS, "M", "2026-09-03", 1), // Stunde der Mitlehrkraft
        entry(DANIEL, "D", "2026-09-04", 1), // anderes Fach
        entry(DANIEL, "M", "2027-02-10", 1), // 2. Halbjahr
      ])
      .returning({ id: classbookEntries.id });
    await h.db.insert(classbookAbsences).values([
      { entryId: rows[0]!.id, studentId: LEA, kind: "absent" },
      { entryId: rows[1]!.id, studentId: LEA, kind: "late", minutesLate: 10 },
      { entryId: rows[1]!.id, studentId: other, kind: "absent", excused: true },
      { entryId: rows[2]!.id, studentId: LEA, kind: "absent" },
      { entryId: rows[3]!.id, studentId: LEA, kind: "absent" },
      { entryId: rows[4]!.id, studentId: LEA, kind: "absent" },
    ]);
    const [book] = await h.db.select().from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId));
    expect(Object.fromEntries(await ownAbsenceCounts(h.db, await p(DANIEL), book!))).toEqual({ [LEA]: 1, [other]: 1 });
    expect(Object.fromEntries(await ownAbsenceCounts(h.db, await p(TOBIAS), book!))).toEqual({ [LEA]: 1 });
  });

  it("fremde Lehrkraft, Admin mit `*` und Klassenleitung können keine Spalten oder Gewichte ändern und sehen keine Teilnoten", async () => {
    await h.db.insert(grants).values({ role: "admin", permission: "*" });
    const [col] = await h.db.select({ id: notenbuchColumns.id }).from(notenbuchColumns).where(eq(notenbuchColumns.bookId, bookId));
    for (const id of [MURAT, ADMIN, JANA]) {
      const viewer = await p(id);
      await expect(updateColumn(h.db, viewer, col!.id, { kind: "sonstige", title: "X" }), id).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteColumn(h.db, viewer, col!.id), id).rejects.toBeInstanceOf(ForbiddenError);
      await expect(moveColumn(h.db, viewer, col!.id, 1), id).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setWeights(h.db, viewer, bookId, { schriftlich: 50, sonstige: 50 }), id).rejects.toBeInstanceOf(ForbiddenError);
      expect(await getBook(h.db, viewer, bookId), id).toBeNull();
    }
    // Klassenleitung: nur Halbjahreswerte, keine Spalten/Teilnoten/Kommentare
    const overview = (await termOverview(h.db, await p(JANA), "g-7b"))!;
    expect(JSON.stringify(overview)).not.toMatch(/Mündlich|Klassenarbeit|"value"|"comment"|"version"/);
    await h.db.delete(grants).where(eq(grants.permission, "*"));
  });

  it("gesperrtes Buch: Spalten, Gewichte und Klausurplan-Übernahme abgelehnt", async () => {
    await h.db.update(notenbuchBooks).set({ lockedAt: new Date() }).where(eq(notenbuchBooks.id, bookId));
    const daniel = await p(DANIEL);
    const [col] = await h.db.select({ id: notenbuchColumns.id }).from(notenbuchColumns).where(eq(notenbuchColumns.bookId, bookId));
    await expect(updateColumn(h.db, daniel, col!.id, { kind: "sonstige", title: "X" })).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    await expect(deleteColumn(h.db, daniel, col!.id)).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    await expect(moveColumn(h.db, daniel, col!.id, 1)).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    await expect(setWeights(h.db, daniel, bookId, { schriftlich: 50, sonstige: 50 })).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    await expect(addColumnFromExam(h.db, daniel, bookId, "x")).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    await h.db.update(notenbuchBooks).set({ lockedAt: null }).where(eq(notenbuchBooks.id, bookId));
  });
});
