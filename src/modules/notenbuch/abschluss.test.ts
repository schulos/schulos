// Notenbuch (P5-13): Halbjahresabschluss – Vorschlag → Festlegen (abweichend erlaubt) → Sperren; Entsperren nur mit
// `notenbuch.unlock` (Begründung, Audit); Übergabeliste je Klasse (nur Halbjahreswerte, protokolliert); CSV-Export nur mit
// `notenbuch.export` (nur festgelegte Halbjahresnoten, Audit). Rechte: fremde Lehrkraft, Admin `*`, Klassenleitung ohne Teilnoten.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import {
  appSettings,
  auditLog,
  grants,
  notenbuchBooks,
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
  adoptSuggestions,
  createBook,
  exportTermCsv,
  finalGradeError,
  getBook,
  handoverClasses,
  hasNotenbuchRight,
  lockBook,
  lockedBooks,
  notenbuchAccess,
  setEntry,
  setFinalGrade,
  termOverview,
  unlockBook,
} from "./service";

const TODAY = "2026-10-07";
const JANA = "u-jana.brandt"; // Klassenleitung 7b
const TOBIAS = "u-tobias.kleine"; // Mathe 7b
const DANIEL = "u-daniel.okafor"; // Mathe 7b
const MURAT = "u-murat.yilmaz"; // fremde Lehrkraft
const PETRA = "u-petra.lindner"; // Schulleitung: term_view, export, unlock
const SABINE = "u-sabine.kowalski";
const ADMIN = "u-admin";
const LEA = "u-lea.schaefer";
const SEL = { schoolYearId: "sj-2026-27", term: 1 };
const csvText = (b: Uint8Array) => new TextDecoder().decode(b);

describe("Notenbuch: Halbjahresabschluss (P5-13)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let bookId = "";
  let col = "";
  let students: { id: string; name: string }[] = [];

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAssignments);
    const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const [a] = await h.db.insert(timetableAssignments).values({ schoolYearId: year!.id, subjectId: "M", hours: 4 }).returning({ id: timetableAssignments.id });
    await h.db.insert(timetableAssignmentGroups).values({ assignmentId: a!.id, groupId: "g-7b" });
    await h.db.insert(timetableAssignmentTeachers).values([
      { assignmentId: a!.id, teacherId: DANIEL },
      { assignmentId: a!.id, teacherId: TOBIAS },
    ]);
    const daniel = await p(DANIEL);
    bookId = await createBook(h.db, daniel, { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten6" }, TODAY);
    col = await addColumn(h.db, daniel, bookId, { kind: "sonstige", title: "Mündlich Oktober" });
    students = (await getBook(h.db, daniel, bookId))!.students;
    await setEntry(h.db, daniel, { columnId: col, studentId: LEA, value: "2", comment: "Kommentar nur für Fachlehrkräfte" });
  }, 60_000);
  afterAll(() => h.close());

  const final = async (studentId: string) =>
    (await h.db.select().from(notenbuchTermGrades).where(and(eq(notenbuchTermGrades.bookId, bookId), eq(notenbuchTermGrades.studentId, studentId))))[0];

  it("rein: festzulegende Noten je Skala oder „befreit“", () => {
    expect(finalGradeError("noten6", "3")).toBeNull();
    expect(finalGradeError("noten6", "befreit")).toBeNull();
    expect(finalGradeError("noten6", "2+")).toMatch(/1 bis 6/);
    expect(finalGradeError("noten6_tendenz", "2+")).toBeNull();
    expect(finalGradeError("punkte15", "11")).toBeNull();
    expect(finalGradeError("punkte15", "fehlt")).toMatch(/0 bis 15/);
  });

  it("Festlegen: abweichend vom Vorschlag erlaubt, zurücknehmen mit leerem Wert; nur Lehrkräfte des Buchs", async () => {
    const tobias = await p(TOBIAS);
    await expect(setFinalGrade(h.db, tobias, bookId, LEA, "7")).rejects.toMatchObject({ fieldErrors: { final: /1 bis 6/ } });
    await expect(setFinalGrade(h.db, tobias, bookId, ADMIN, "2")).rejects.toMatchObject({ fieldErrors: { studentId: /gehört nicht/ } });
    await setFinalGrade(h.db, tobias, bookId, LEA, " 1 ");
    expect(await final(LEA)).toMatchObject({ computed: "2", final: "1", finalizedBy: TOBIAS });
    await setFinalGrade(h.db, tobias, bookId, LEA, "");
    expect(await final(LEA)).toMatchObject({ computed: "2", final: null, finalizedAt: null, finalizedBy: null });
    await h.db.insert(grants).values({ role: "admin", permission: "*" });
    for (const id of [MURAT, ADMIN, JANA, PETRA]) await expect(setFinalGrade(h.db, await p(id), bookId, LEA, "1"), id).rejects.toBeInstanceOf(ForbiddenError);
    for (const id of [MURAT, ADMIN, JANA, PETRA]) await expect(adoptSuggestions(h.db, await p(id), bookId), id).rejects.toBeInstanceOf(ForbiddenError);
    for (const id of [MURAT, ADMIN, JANA, PETRA]) await expect(lockBook(h.db, await p(id), bookId), id).rejects.toBeInstanceOf(ForbiddenError);
    await h.db.delete(grants).where(eq(grants.permission, "*"));
  });

  it("Vorschläge übernehmen nur, wo noch nichts festgelegt ist; Sperren erst, wenn alle eine Note haben", async () => {
    const daniel = await p(DANIEL);
    const other = students.find((s) => s.id !== LEA)!.id;
    await setFinalGrade(h.db, daniel, bookId, other, "befreit");
    expect(await adoptSuggestions(h.db, daniel, bookId)).toBe(1); // nur Lea hat einen Vorschlag
    expect(await final(LEA)).toMatchObject({ final: "2", finalizedBy: DANIEL });
    expect(await final(other)).toMatchObject({ final: "befreit" });
    await expect(lockBook(h.db, daniel, bookId)).rejects.toMatchObject({ fieldErrors: { book: new RegExp(`Für ${students.length - 2} Personen fehlt`) } });
    // der Rest bekommt Noten: Vorschlag aus einer Teilnote, dann übernehmen
    for (const s of students.filter((x) => x.id !== LEA && x.id !== other)) await setEntry(h.db, daniel, { columnId: col, studentId: s.id, value: "3" });
    expect(await adoptSuggestions(h.db, daniel, bookId)).toBe(students.length - 2);
    await lockBook(h.db, daniel, bookId, new Date("2027-01-20T12:00:00Z"));
    const [b] = await h.db.select({ lockedAt: notenbuchBooks.lockedAt }).from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId));
    expect(b!.lockedAt).toEqual(new Date("2027-01-20T12:00:00Z"));
    const logs = await h.db.select().from(auditLog).where(eq(auditLog.target, bookId));
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["notenbuch.festlegen", "notenbuch.abschliessen"]));
  });

  it("gesperrtes Buch: keine Teilnoten, keine Halbjahresnoten, kein erneutes Sperren", async () => {
    const daniel = await p(DANIEL);
    await expect(setEntry(h.db, daniel, { columnId: col, studentId: LEA, value: "1" })).rejects.toMatchObject({ fieldErrors: { value: /gesperrt/ } });
    await expect(setFinalGrade(h.db, daniel, bookId, LEA, "1")).rejects.toMatchObject({ fieldErrors: { final: /gesperrt/ } });
    await expect(adoptSuggestions(h.db, daniel, bookId)).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    await expect(lockBook(h.db, daniel, bookId)).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    // lesen geht weiter
    expect((await getBook(h.db, daniel, bookId))!.book.lockedAt).not.toBeNull();
  });

  it("Übergabeliste: Klassenleitung und term_view sehen Halbjahreswerte mit „abgeschlossen“, nie Teilnoten – Abruf protokolliert", async () => {
    const jana = (await termOverview(h.db, await p(JANA), "g-7b", new Date(), SEL))!;
    expect(jana.grades.find((g) => g.studentId === LEA)).toMatchObject({ subjectId: "M", computed: "2", final: "2", finalized: true, locked: true });
    expect(JSON.stringify(jana)).not.toMatch(/Mündlich|Kommentar nur|"value"|"comment"/);
    expect((await termOverview(h.db, await p(JANA), "g-7b", new Date(), { schoolYearId: "sj-2026-27", term: 2 }))!.grades).toEqual([]);
    expect(await termOverview(h.db, await p(PETRA), "g-7b", new Date(), SEL)).not.toBeNull();
    for (const id of [DANIEL, MURAT, SABINE, ADMIN]) expect(await termOverview(h.db, await p(id), "g-7b", new Date(), SEL), id).toBeNull();
    const reads = await h.db.select().from(auditLog).where(eq(auditLog.action, "lesen.notenbuch"));
    expect(new Set(reads.map((r) => r.actorId))).toEqual(new Set([JANA, PETRA]));
  });

  it("Klassen für Übergabeliste und Export je nach Recht", async () => {
    expect((await handoverClasses(h.db, await p(JANA))).map((c) => c.id)).toEqual(["g-7b"]);
    expect(await handoverClasses(h.db, await p(JANA), "export")).toEqual([]);
    expect((await handoverClasses(h.db, await p(DANIEL))).map((c) => c.id)).not.toContain("g-7b"); // nur eigene Klasse (5b)
    const petra = await handoverClasses(h.db, await p(PETRA));
    expect(petra.length).toBeGreaterThan(5);
    expect(petra.map((c) => c.id)).toContain("g-7b");
    expect(await handoverClasses(h.db, await p(PETRA), "export")).toEqual(petra);
    expect(await handoverClasses(h.db, await p(ADMIN))).toEqual([]);
    expect((await notenbuchAccess(h.db, await p(PETRA))).unlock).toBe(true);
    expect((await notenbuchAccess(h.db, await p(JANA))).unlock).toBe(false);
  });

  it("CSV-Export: nur mit `notenbuch.export`, nur festgelegte Halbjahresnoten, protokolliert", async () => {
    await h.db.insert(grants).values({ role: "admin", permission: "*" });
    for (const id of [JANA, DANIEL, MURAT, SABINE, ADMIN]) await expect(exportTermCsv(h.db, await p(id), "g-7b", SEL, "utf8"), id).rejects.toBeInstanceOf(ForbiddenError);
    await h.db.delete(grants).where(eq(grants.permission, "*"));
    const petra = await p(PETRA);
    await expect(exportTermCsv(h.db, petra, "g-schulleitung", SEL, "utf8")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportTermCsv(h.db, petra, "g-7b", { ...SEL, term: 3 }, "utf8")).rejects.toMatchObject({ fieldErrors: { term: /Halbjahr/ } });
    const r = await exportTermCsv(h.db, petra, "g-7b", SEL, "utf8");
    expect(r.filename).toBe("halbjahreswerte-klasse-7b-2026-27-hj1.csv");
    const text = csvText(r.body);
    const [head, ...lines] = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(head).toBe("Klasse;Nachname;Vorname;Fach;Fachkürzel;Lerngruppe;Schuljahr;Halbjahr;Note;Status");
    expect(lines).toHaveLength(students.length);
    expect(lines.find((l) => l.includes("Schäfer"))).toMatch(/^Klasse 7b;Schäfer;Lea;[^;]+;M;Klasse 7b;2026\/27;1;2;festgelegt$/);
    expect(text).not.toMatch(/Mündlich|Kommentar nur/);
    expect(r.count).toBe(students.length);
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.export"));
    expect(log).toMatchObject({ actorId: PETRA, target: "klasse:g-7b", meta: { schuljahr: "sj-2026-27", halbjahr: 1, zeilen: students.length, kodierung: "utf8" } });
    // Windows-1252 für ältere Programme
    const cp = await exportTermCsv(h.db, petra, "g-7b", SEL, "cp1252");
    expect(cp.encoding).toBe("cp1252");
    expect(Array.from(cp.body.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it("Entsperren nur mit `notenbuch.unlock`, mit Begründung und Audit – ohne Noten zu sehen", async () => {
    await h.db.insert(grants).values({ role: "admin", permission: "*" });
    for (const id of [JANA, DANIEL, MURAT, SABINE, ADMIN]) {
      const viewer = await p(id);
      expect(hasNotenbuchRight(viewer, "notenbuch.unlock"), id).toBe(false);
      await expect(lockedBooks(h.db, viewer), id).rejects.toBeInstanceOf(ForbiddenError);
      await expect(unlockBook(h.db, viewer, bookId, "Korrektur"), id).rejects.toBeInstanceOf(ForbiddenError);
    }
    await h.db.delete(grants).where(eq(grants.permission, "*"));
    const petra = await p(PETRA);
    const list = await lockedBooks(h.db, petra);
    expect(list).toEqual([expect.objectContaining({ id: bookId, groupName: "Klasse 7b", term: 1, lockedAt: expect.any(Date) })]);
    expect(JSON.stringify(list)).not.toMatch(/computed|final|Mündlich/);
    expect(await getBook(h.db, petra, bookId)).toBeNull();
    await expect(unlockBook(h.db, petra, bookId, " ")).rejects.toMatchObject({ fieldErrors: { reason: /begründen/ } });
    await expect(unlockBook(h.db, petra, bookId, "x".repeat(201))).rejects.toMatchObject({ fieldErrors: { reason: /200/ } });
    await expect(unlockBook(h.db, petra, "gibt-es-nicht", "Korrektur")).rejects.toBeInstanceOf(ForbiddenError);
    await unlockBook(h.db, petra, bookId, "Nachtrag einer Note nach Widerspruch");
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.entsperren"));
    expect(log).toMatchObject({ actorId: PETRA, target: bookId, meta: { grund: "Nachtrag einer Note nach Widerspruch" } });
    await expect(unlockBook(h.db, petra, bookId, "nochmal")).rejects.toMatchObject({ fieldErrors: { book: /nicht gesperrt/ } });
    // Lehrkraft kann wieder ändern; festgelegte Noten bleiben
    await setFinalGrade(h.db, await p(DANIEL), bookId, LEA, "1");
    expect(await final(LEA)).toMatchObject({ final: "1" });
    expect(await lockedBooks(h.db, petra)).toEqual([]);
  });
});
