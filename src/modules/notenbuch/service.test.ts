// Notenbuch (P5-11): Rechte und Sichtbarkeit – Teilnoten nur Fachlehrkräfte des Buchs (Mitlehrkräfte gleichberechtigt, keine
// Vertretung), Halbjahreswerte für Klassenleitung und `notenbuch.term_view` (protokolliert), Übertragung, 2FA-Pflicht fürs Modul,
// kein Admin-Override (Rolle `admin` und Grant `*` öffnen nichts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import {
  appSettings,
  auditLog,
  grants,
  notenbuchBooks,
  notenbuchBookTeachers,
  notenbuchEntries,
  notenbuchTermGrades,
  parentChild,
  schoolYears,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  timetableSubstitutions,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  addColumn,
  bookOptions,
  booksForTransfer,
  createBook,
  exportTermCsv,
  getBook,
  hasNotenbuchRight,
  lockBook,
  lockedBooks,
  myBooks,
  notenbuchAccess,
  NotenbuchTwoFactorError,
  setEntry,
  termOverview,
  transferBook,
  transferTargets,
  twoFactorReady,
  twoFactorSatisfied,
  unlockBook,
} from "./service";

const TODAY = "2026-10-07";
const JANA = "u-jana.brandt"; // Klassenleitung 7b, Deutsch in der 7b (Stundenplan)
const TOBIAS = "u-tobias.kleine"; // Mathe in der 7b (Lehrauftrag, Teamteaching), Mitglied der Gruppe Schulleitung
const DANIEL = "u-daniel.okafor"; // Mathe in der 7b (Lehrauftrag, Teamteaching)
const MURAT = "u-murat.yilmaz"; // vertritt nur eine Stunde in der 7b
const PETRA = "u-petra.lindner"; // Schulleitung (notenbuch.term_view/transfer/export über die Gruppe)
const SABINE = "u-sabine.kowalski"; // Verwaltung
const ADMIN = "u-admin";
const LEA = "u-lea.schaefer"; // Schülerin 7b

describe("Notenbuch: Rechte und Sichtbarkeit", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let parent = "";
  let bookId = "";
  let columnId = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    // echte Instanz statt Demo: 2FA wird durchgesetzt; alle haben sie eingerichtet (einzelne Tests nehmen sie weg)
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    // eigener, überschaubarer Unterricht in der 7b
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAssignments);
    const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const [a] = await h.db.insert(timetableAssignments).values({ schoolYearId: year!.id, subjectId: "M", hours: 4 }).returning({ id: timetableAssignments.id });
    await h.db.insert(timetableAssignmentGroups).values({ assignmentId: a!.id, groupId: "g-7b" });
    await h.db.insert(timetableAssignmentTeachers).values([
      { assignmentId: a!.id, teacherId: DANIEL },
      { assignmentId: a!.id, teacherId: TOBIAS },
    ]);
    const [lesson] = await h.db
      .insert(timetableLessons)
      .values({ weekday: 0, validFrom: "2026-08-01", validUntil: null, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: JANA, roomId: "106" })
      .returning({ id: timetableLessons.id });
    await h.db.insert(timetableSubstitutions).values({ lessonId: lesson!.id, date: TODAY, kind: "substitute", substituteId: MURAT });
    const [pc] = await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA));
    parent = pc!.parentId;
  }, 60_000);
  afterAll(() => h.close());

  it("Rechte zählen nur ausdrücklich: Rolle admin und Grant `*` öffnen nichts (rein)", () => {
    const base: PermissionSet = { userId: "x", role: "admin", locked: false, granted: new Set(["*"]), memberOf: new Set(), leaderOf: new Set() };
    expect(hasNotenbuchRight(base, "notenbuch.own")).toBe(false);
    expect(hasNotenbuchRight(base, "notenbuch.term_view")).toBe(false);
    expect(hasNotenbuchRight({ ...base, role: "lehrkraft", granted: new Set(["notenbuch.*"]) }, "notenbuch.term_view")).toBe(true);
    expect(hasNotenbuchRight({ ...base, role: "lehrkraft", granted: new Set(["notenbuch.own"]) }, "notenbuch.own")).toBe(true);
    expect(hasNotenbuchRight({ ...base, role: "lehrkraft", granted: new Set(["notenbuch.own"]), locked: true }, "notenbuch.own")).toBe(false);
    expect(hasNotenbuchRight({ ...base, role: "lehrkraft", granted: new Set(["notenbuch.own"]), twoFactorPending: true }, "notenbuch.own")).toBe(false);
    expect(twoFactorSatisfied(true, false)).toBe(true);
    expect(twoFactorSatisfied(false, true)).toBe(true);
    expect(twoFactorSatisfied(false, false)).toBe(false);
  });

  it("Anlegen nur aus eigenen Lehraufträgen bzw. eigenem Unterricht – Vertretung zählt nicht", async () => {
    expect(await bookOptions(h.db, await p(DANIEL), TODAY)).toEqual([
      { groupId: "g-7b", groupName: "Klasse 7b", subjectId: "M", subjectName: expect.any(String), assignmentId: expect.any(String), teacherIds: [DANIEL, TOBIAS].sort() },
    ]);
    expect((await bookOptions(h.db, await p(JANA), TODAY)).map((o) => `${o.groupId}|${o.subjectId}`)).toEqual(["g-7b|D"]);
    for (const id of [MURAT, ADMIN, SABINE, LEA, parent]) expect(await bookOptions(h.db, await p(id), TODAY), id).toEqual([]);
  });

  it("legt ein Buch mit allen Lehrkräften des Lehrauftrags an; fremder Unterricht und Doppelungen werden abgelehnt", async () => {
    const daniel = await p(DANIEL);
    await expect(createBook(h.db, daniel, { groupId: "g-7b", subjectId: "M", term: 3, scale: "noten6" }, TODAY)).rejects.toMatchObject({ fieldErrors: { term: /Halbjahr/ } });
    await expect(createBook(h.db, daniel, { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten9" }, TODAY)).rejects.toMatchObject({ fieldErrors: { scale: /Skala/ } });
    await expect(createBook(h.db, daniel, { groupId: "g-7b", subjectId: "D", term: 1, scale: "noten6" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    for (const id of [MURAT, JANA, ADMIN, PETRA])
      await expect(createBook(h.db, await p(id), { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten6" }, TODAY), id).rejects.toBeInstanceOf(ForbiddenError);
    bookId = await createBook(h.db, daniel, { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten6_tendenz" }, TODAY);
    const teachers = await h.db.select({ id: notenbuchBookTeachers.teacherId }).from(notenbuchBookTeachers).where(eq(notenbuchBookTeachers.bookId, bookId));
    expect(teachers.map((t) => t.id).sort()).toEqual([DANIEL, TOBIAS].sort());
    await expect(createBook(h.db, await p(TOBIAS), { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten6" }, TODAY)).rejects.toMatchObject({ fieldErrors: { groupId: /schon/ } });
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.anlegen"))).toHaveLength(1);
    expect((await myBooks(h.db, await p(TOBIAS))).map((b) => b.id)).toEqual([bookId]);
  });

  it("Mitlehrkräfte sind gleichberechtigt: Spalte und Teilnoten, geprüft und mit Version", async () => {
    columnId = await addColumn(h.db, await p(DANIEL), bookId, { kind: "schriftlich", title: "1. Klassenarbeit", date: "2026-09-30", maxPoints: 40 });
    const tobias = await p(TOBIAS);
    await expect(setEntry(h.db, tobias, { columnId, studentId: LEA, value: "41" })).rejects.toMatchObject({ fieldErrors: { value: /Höchstens 40/ } });
    await expect(setEntry(h.db, tobias, { columnId, studentId: ADMIN, value: "20" })).rejects.toMatchObject({ fieldErrors: { studentId: /gehört nicht/ } });
    await expect(setEntry(h.db, tobias, { columnId, studentId: LEA, value: "20", comment: "x".repeat(201) })).rejects.toMatchObject({ fieldErrors: { comment: /200/ } });
    await expect(setEntry(h.db, tobias, { columnId, studentId: LEA, value: "", comment: "nur Kommentar" })).rejects.toBeInstanceOf(ValidationError);
    const v1 = await setEntry(h.db, tobias, { columnId, studentId: LEA, value: "34", comment: "sauber gerechnet" }); // 85 % → 1−
    expect(v1).toBeGreaterThan(0);
    const v2 = await setEntry(h.db, await p(DANIEL), { columnId, studentId: LEA, value: "30", expectedVersion: v1 }); // 75 % → 2
    expect(v2).toBeGreaterThan(v1);
    await expect(setEntry(h.db, tobias, { columnId, studentId: LEA, value: "31", expectedVersion: v1 })).rejects.toMatchObject({ fieldErrors: { value: /inzwischen/ } });
    const [entry] = await h.db.select().from(notenbuchEntries).where(and(eq(notenbuchEntries.columnId, columnId), eq(notenbuchEntries.studentId, LEA)));
    expect(entry).toMatchObject({ value: "30", comment: null, version: v2, updatedBy: DANIEL });
    const view = (await getBook(h.db, tobias, bookId))!;
    expect(view.results.get(LEA)).toMatchObject({ grade: "2" });
    expect(view.entries.get(`${columnId}:${LEA}`)).toEqual({ value: "30", comment: null, version: v2 });
    const [term] = await h.db.select().from(notenbuchTermGrades).where(eq(notenbuchTermGrades.studentId, LEA));
    expect(term).toMatchObject({ bookId, computed: "2", final: null });
  });

  it("Teilnoten sehen nur die Lehrkräfte des Buchs – nicht Klassenleitung, Schulleitung, Verwaltung, Admin, Vertretung, Familie", async () => {
    for (const id of [DANIEL, TOBIAS]) expect(await getBook(h.db, await p(id), bookId), id).not.toBeNull();
    for (const id of [JANA, PETRA, SABINE, ADMIN, MURAT, LEA, parent]) {
      const viewer = await p(id);
      expect(await getBook(h.db, viewer, bookId), id).toBeNull();
      expect(await myBooks(h.db, viewer), id).toEqual([]);
      await expect(setEntry(h.db, viewer, { columnId, studentId: LEA, value: "1" }), id).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addColumn(h.db, viewer, bookId, { kind: "sonstige", title: "X" }), id).rejects.toBeInstanceOf(ForbiddenError);
    }
    // fremd und unbekannt sind nicht zu unterscheiden
    expect(await getBook(h.db, await p(DANIEL), "gibt-es-nicht")).toBeNull();
    await expect(setEntry(h.db, await p(DANIEL), { columnId: "gibt-es-nicht", studentId: LEA, value: "1" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Admin mit `*` (Rolle und Grant) sieht weder Teilnoten noch – ohne term_view – Halbjahreswerte", async () => {
    await h.db.insert(grants).values([
      { role: "admin", permission: "*" },
      { role: "verwaltung", permission: "*" },
    ]);
    for (const id of [ADMIN, SABINE]) {
      const viewer = await p(id);
      expect(viewer.granted.has("*"), id).toBe(true);
      expect(hasNotenbuchRight(viewer, "notenbuch.own"), id).toBe(false);
      expect(hasNotenbuchRight(viewer, "notenbuch.term_view"), id).toBe(false);
      expect(await getBook(h.db, viewer, bookId), id).toBeNull();
      expect(await termOverview(h.db, viewer, "g-7b"), id).toBeNull();
      expect(await bookOptions(h.db, viewer, TODAY), id).toEqual([]);
      expect((await notenbuchAccess(h.db, viewer)).own, id).toBe(false);
    }
    await h.db.delete(grants).where(eq(grants.permission, "*"));
  });

  it("Halbjahreswerte: Klassenleitung (automatisch) und term_view – ohne Teilnoten, jeder Abruf protokolliert", async () => {
    const now = new Date("2026-10-07T10:00:00Z");
    const jana = (await termOverview(h.db, await p(JANA), "g-7b", now))!;
    expect(jana.groupName).toBe("Klasse 7b");
    const lea = jana.grades.filter((g) => g.studentId === LEA);
    expect(lea).toEqual([{ studentId: LEA, subjectId: "M", subjectName: expect.any(String), groupName: "Klasse 7b", schoolYearName: "2026/27", term: 1, computed: "2", final: null, finalized: false, locked: false }]);
    // nichts aus Spalten oder Einträgen
    expect(JSON.stringify(jana)).not.toMatch(/Klassenarbeit|sauber|"value"|"comment"/);
    expect(await termOverview(h.db, await p(PETRA), "g-7b", now)).not.toBeNull();
    // wiederholtes Blättern zählt innerhalb von 30 Minuten einmal
    await termOverview(h.db, await p(JANA), "g-7b", new Date(now.getTime() + 60_000));
    const reads = await h.db.select().from(auditLog).where(eq(auditLog.action, "lesen.notenbuch"));
    expect(reads.map((r) => [r.actorId, r.target]).sort()).toEqual([
      [JANA, "klasse:g-7b"],
      [PETRA, "klasse:g-7b"],
    ]);
    // keine Klassenleitung, kein Recht → nichts (auch nicht für Fachlehrkräfte, Vertretung, Verwaltung, Admin, Familie)
    for (const id of [DANIEL, MURAT, SABINE, ADMIN, LEA, parent]) expect(await termOverview(h.db, await p(id), "g-7b", now), id).toBeNull();
    // nur Klassen, keine Kurse oder unbekannten Gruppen
    expect(await termOverview(h.db, await p(PETRA), "g-schulleitung", now)).toBeNull();
    expect(await termOverview(h.db, await p(PETRA), "gibt-es-nicht", now)).toBeNull();
  });

  it("Übertragen nur mit Recht, ohne Noten zu sehen; danach führt die neue Lehrkraft das Buch", async () => {
    for (const id of [DANIEL, JANA, MURAT, SABINE]) {
      await expect(booksForTransfer(h.db, await p(id)), id).rejects.toBeInstanceOf(ForbiddenError);
      await expect(transferBook(h.db, await p(id), bookId, { toTeacherId: MURAT }), id).rejects.toBeInstanceOf(ForbiddenError);
    }
    const petra = await p(PETRA);
    const list = await booksForTransfer(h.db, petra);
    expect(list).toEqual([{ id: bookId, groupName: "Klasse 7b", subjectName: expect.any(String), schoolYearName: "2026/27", term: 1, teachers: expect.any(Array) }]);
    expect(JSON.stringify(list)).not.toMatch(/Klassenarbeit|computed|sauber/);
    await expect(transferBook(h.db, petra, bookId, { toTeacherId: LEA })).rejects.toMatchObject({ fieldErrors: { toTeacherId: /Lehrkraft/ } });
    await expect(transferBook(h.db, petra, "gibt-es-nicht", { toTeacherId: MURAT })).rejects.toBeInstanceOf(ForbiddenError);
    await transferBook(h.db, petra, bookId, { toTeacherId: MURAT, removeTeacherId: DANIEL });
    expect(await getBook(h.db, await p(MURAT), bookId)).not.toBeNull();
    expect(await getBook(h.db, await p(DANIEL), bookId)).toBeNull();
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.uebertragen"));
    expect(entry).toMatchObject({ actorId: PETRA, target: bookId, meta: { to: MURAT, from: DANIEL } });
    // Admin übertragen per ausdrücklichem Vorgabe-Recht – auch ohne Einsicht
    const admin = await p(ADMIN);
    expect(hasNotenbuchRight(admin, "notenbuch.transfer")).toBe(true);
    await transferBook(h.db, admin, bookId, { toTeacherId: DANIEL });
    expect(await getBook(h.db, admin, bookId)).toBeNull();
  });

  it("2FA-Pflicht fürs Modul: ohne eingerichtete Zwei-Faktor-Anmeldung wird alles abgelehnt (Demo ausgenommen)", async () => {
    await h.db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, DANIEL));
    // Fachlehrkraft ohne Verwaltungsrechte: im Kern (noch) keine 2FA-Pflicht, im Notenbuch schon
    const daniel = await p(DANIEL);
    expect(daniel.twoFactorPending).toBeFalsy();
    expect(await twoFactorReady(h.db, daniel)).toBe(false);
    expect(await notenbuchAccess(h.db, daniel)).toMatchObject({ any: true, own: true, twoFactor: false });
    await expect(getBook(h.db, daniel, bookId)).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
    await expect(myBooks(h.db, daniel)).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
    await expect(setEntry(h.db, daniel, { columnId, studentId: LEA, value: "1" })).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
    await expect(addColumn(h.db, daniel, bookId, { kind: "sonstige", title: "Mündlich" })).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
    await expect(createBook(h.db, daniel, { groupId: "g-7b", subjectId: "M", term: 2, scale: "noten6" }, TODAY)).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
    await expect(termOverview(h.db, daniel, "g-7b")).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
    await expect(transferBook(h.db, daniel, bookId, { toTeacherId: JANA })).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
    const [entry] = await h.db.select({ value: notenbuchEntries.value }).from(notenbuchEntries).where(eq(notenbuchEntries.columnId, columnId));
    expect(entry!.value).toBe("30");
    // Demo-Instanz: wie beim Kern nicht verlangt
    await h.db.insert(appSettings).values({ key: "demo", value: true });
    expect(await getBook(h.db, daniel, bookId)).not.toBeNull();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, DANIEL));
  });

  it("GATE-5a: 2FA-Pflicht auch für Abschluss, Entsperren, Übertragen-Listen und Export", async () => {
    await h.db.update(users).set({ twoFactorEnabled: false }).where(inArray(users.id, [PETRA, DANIEL]));
    try {
      const petra = await p(PETRA);
      const daniel = await p(DANIEL);
      // Schulleitung (Verwaltungsrechte): schon der Kern verlangt den zweiten Faktor – das Notenbuch öffnet gar nicht erst
      expect(petra.twoFactorPending).toBe(true);
      expect(await notenbuchAccess(h.db, petra)).toMatchObject({ any: false });
      const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
      await expect(lockBook(h.db, daniel, bookId)).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
      await expect(lockedBooks(h.db, petra)).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
      await expect(unlockBook(h.db, petra, bookId, "Nachtrag")).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
      await expect(booksForTransfer(h.db, petra)).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
      await expect(transferTargets(h.db, petra)).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
      await expect(exportTermCsv(h.db, petra, "g-7b", { schoolYearId: year!.id, term: 1 }, "utf8")).rejects.toBeInstanceOf(NotenbuchTwoFactorError);
      const [book] = await h.db.select({ lockedAt: notenbuchBooks.lockedAt }).from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId));
      expect(book!.lockedAt).toBeNull();
    } finally {
      await h.db.update(users).set({ twoFactorEnabled: true }).where(inArray(users.id, [PETRA, DANIEL]));
    }
  });

  it("gesperrtes Buch (Halbjahresabschluss) nimmt keine Änderungen an", async () => {
    await h.db.update(notenbuchBooks).set({ lockedAt: new Date() }).where(eq(notenbuchBooks.id, bookId));
    const tobias = await p(TOBIAS);
    await expect(setEntry(h.db, tobias, { columnId, studentId: LEA, value: "1" })).rejects.toMatchObject({ fieldErrors: { value: /gesperrt/ } });
    await expect(addColumn(h.db, tobias, bookId, { kind: "sonstige", title: "Mündlich" })).rejects.toMatchObject({ fieldErrors: { book: /gesperrt/ } });
    expect((await myBooks(h.db, tobias))[0]).toMatchObject({ id: bookId, locked: true });
  });
});
