// GATE-5a: Regressionstests zu den Review-Befunden (G5A-C…/S…) – Rennen, Revisionen, Rechte. Parallele Transaktionen lassen sich
// mit PGlite (eine Verbindung) nicht echt verschränken; `beforeTransaction` simuliert den Fall „eine andere Anfrage hat genau
// vor unserer Transaktion geschrieben, nachdem unsere Vorprüfung schon lief“.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db, DbHandle } from "@/core/db/client";
import {
  appSettings,
  auditLog,
  grants,
  groupMembers,
  groups,
  notenbuchBooks,
  notifications,
  notenbuchEntries,
  notenbuchTermGrades,
  schoolYears,
  subjects,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { deleteGroup } from "@/modules/verwaltung/groups";
import { deleteSchoolYear } from "@/modules/verwaltung/school-years";
import { deleteSubject, subjectUsage } from "@/modules/verwaltung/stammdaten";
import { ValidationError } from "@/modules/verwaltung/users";
import { syncOfflineOps } from "./offline";
import {
  addColumn,
  createBook,
  EntryConflictError,
  getBook,
  insertNewEntry,
  lockBook,
  setEntry,
  setFinalGrade,
  handoverClasses,
  handoverGrid,
  hasNotenbuchRight,
  type TermGradeRow,
  notenbuchAccess,
  termOverview,
  transferBook,
  transferTargets,
} from "./service";

const TODAY = "2026-10-07";
const TOBIAS = "u-tobias.kleine";
const DANIEL = "u-daniel.okafor";
const LEA = "u-lea.schaefer";
const JANA = "u-jana.brandt"; // Klassenleitung 7b
const PETRA = "u-petra.lindner"; // Schulleitung (transfer über die Gruppe), Lehrkraft
const MURAT = "u-murat.yilmaz";
const ADMIN = "u-admin";

/** Db, deren nächste Transaktion erst `hook` ausführt (eine „parallele“ Anfrage, die genau dazwischen schreibt). */
function beforeTransaction(db: Db, hook: () => Promise<void>): Db {
  let pending = true;
  return new Proxy(db, {
    get(target, key) {
      if (key === "transaction")
        return async (...args: Parameters<Db["transaction"]>) => {
          if (pending) {
            pending = false;
            await hook();
          }
          return target.transaction(...args);
        };
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function"
        ? (v as (...a: unknown[]) => unknown).bind(target)
        : v;
    },
  });
}

describe("GATE-5a: Review-Befunde Notenbuch", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let bookId = "";
  let col = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAssignments);
    const [year] = await h.db
      .select({ id: schoolYears.id })
      .from(schoolYears)
      .where(eq(schoolYears.isCurrent, true));
    const [a] = await h.db
      .insert(timetableAssignments)
      .values({ schoolYearId: year!.id, subjectId: "M", hours: 4 })
      .returning({ id: timetableAssignments.id });
    await h.db
      .insert(timetableAssignmentGroups)
      .values({ assignmentId: a!.id, groupId: "g-7b" });
    await h.db.insert(timetableAssignmentTeachers).values([
      { assignmentId: a!.id, teacherId: DANIEL },
      { assignmentId: a!.id, teacherId: TOBIAS },
    ]);
    bookId = await createBook(
      h.db,
      await p(DANIEL),
      { groupId: "g-7b", subjectId: "M", term: 1, scale: "noten6" },
      TODAY,
    );
    col = await addColumn(h.db, await p(DANIEL), bookId, {
      kind: "sonstige",
      title: "Mündlich",
    });
  }, 60_000);
  afterAll(() => h.close());

  const cellOf = async (studentId: string) =>
    (
      await h.db
        .select()
        .from(notenbuchEntries)
        .where(
          and(
            eq(notenbuchEntries.columnId, col),
            eq(notenbuchEntries.studentId, studentId),
          ),
        )
    )[0];

  it("G5A-C02: Löschen + Neuanlage vergibt nie wieder eine alte Revision – veraltete Grundrevision kollidiert online und offline", async () => {
    const daniel = await p(DANIEL);
    const tobias = await p(TOBIAS);
    const v1 = await setEntry(h.db, daniel, {
      columnId: col,
      studentId: LEA,
      value: "2",
      expectedVersion: 0,
    });
    // Tobias löscht die Zelle und trägt neu ein
    expect(
      await setEntry(h.db, tobias, {
        columnId: col,
        studentId: LEA,
        value: "",
        expectedVersion: v1,
      }),
    ).toBe(0);
    const v3 = await setEntry(h.db, tobias, {
      columnId: col,
      studentId: LEA,
      value: "5",
      expectedVersion: 0,
    });
    expect(v3).not.toBe(v1);
    expect(v3).toBeGreaterThan(v1);
    // Daniel hatte die Tabelle mit v1 offen bzw. ist mit Grundrevision v1 offline gegangen
    await expect(
      setEntry(h.db, daniel, {
        columnId: col,
        studentId: LEA,
        value: "4",
        expectedVersion: v1,
      }),
    ).rejects.toBeInstanceOf(EntryConflictError);
    const op = {
      opId: crypto.randomUUID(),
      columnId: col,
      studentId: LEA,
      value: "4",
      comment: null,
      baseVersion: v1,
      at: "",
    };
    const [r] = await syncOfflineOps(h.db, daniel, bookId, [op], null);
    expect(r).toMatchObject({
      status: "conflict",
      server: { value: "5", version: v3 },
    });
    expect((await cellOf(LEA))!.value).toBe("5");
  });

  it("G5A-C08: Erstanlage überschreibt keine inzwischen angelegte Zelle", async () => {
    const other = (await getBook(h.db, await p(DANIEL), bookId))!.students.find(
      (s) => s.id !== LEA,
    )!.id;
    const base = { columnId: col, studentId: other, updatedBy: DANIEL };
    expect(
      await insertNewEntry(h.db, { ...base, value: "1", version: 9001 }),
    ).toBe(true);
    // die zweite Erstanlage (gleiche Zelle, eigene Revision) darf nichts überschreiben
    expect(
      await insertNewEntry(h.db, { ...base, value: "6", version: 9002 }),
    ).toBe(false);
    expect(await cellOf(other)).toMatchObject({ value: "1", version: 9001 });
  });

  it("G5A-C09: Abschluss zwischen Vorprüfung und Schreiben – Teilnote und Halbjahresnote werden in der Transaktion abgelehnt", async () => {
    const tobias = await p(TOBIAS);
    const lockNow = () =>
      h.db
        .update(notenbuchBooks)
        .set({ lockedAt: new Date() })
        .where(eq(notenbuchBooks.id, bookId))
        .then(() => undefined);
    const before = (await cellOf(LEA))!;
    await expect(
      setEntry(beforeTransaction(h.db, lockNow), tobias, {
        columnId: col,
        studentId: LEA,
        value: "1",
      }),
    ).rejects.toMatchObject({
      fieldErrors: { value: /gesperrt/ },
    });
    expect((await cellOf(LEA))!.value).toBe(before.value);
    await h.db
      .update(notenbuchBooks)
      .set({ lockedAt: null })
      .where(eq(notenbuchBooks.id, bookId));
    await expect(
      setFinalGrade(beforeTransaction(h.db, lockNow), tobias, bookId, LEA, "2"),
    ).rejects.toMatchObject({ fieldErrors: { final: /gesperrt/ } });
    const [t] = await h.db
      .select()
      .from(notenbuchTermGrades)
      .where(
        and(
          eq(notenbuchTermGrades.bookId, bookId),
          eq(notenbuchTermGrades.studentId, LEA),
        ),
      );
    expect(t!.final).toBeNull();
    await h.db
      .update(notenbuchBooks)
      .set({ lockedAt: null })
      .where(eq(notenbuchBooks.id, bookId));
  });

  it("G5A-C09: nimmt jemand während des Abschlusses eine Halbjahresnote zurück, sperrt das Buch nicht", async () => {
    const daniel = await p(DANIEL);
    const students = (await getBook(h.db, daniel, bookId))!.students;
    for (const s of students)
      await setFinalGrade(h.db, daniel, bookId, s.id, "3");
    const withdraw = () =>
      h.db
        .update(notenbuchTermGrades)
        .set({ final: null, finalizedAt: null })
        .where(
          and(
            eq(notenbuchTermGrades.bookId, bookId),
            eq(notenbuchTermGrades.studentId, LEA),
          ),
        )
        .then(() => undefined);
    await expect(
      lockBook(beforeTransaction(h.db, withdraw), daniel, bookId),
    ).rejects.toMatchObject({ fieldErrors: { book: /1 Person fehlt/ } });
    const [b] = await h.db
      .select({ lockedAt: notenbuchBooks.lockedAt })
      .from(notenbuchBooks)
      .where(eq(notenbuchBooks.id, bookId));
    expect(b!.lockedAt).toBeNull();
  });

  it("G5A-C11: gleichzeitige Doppelanlage endet als Hinweis statt Fehler 500", async () => {
    const [year] = await h.db
      .select({ id: schoolYears.id })
      .from(schoolYears)
      .where(eq(schoolYears.isCurrent, true));
    const parallel = () =>
      h.db
        .insert(notenbuchBooks)
        .values({
          schoolYearId: year!.id,
          term: 2,
          groupId: "g-7b",
          subjectId: "M",
          scale: "noten6",
          weights: {},
          createdBy: TOBIAS,
        })
        .then(() => undefined);
    const err = await createBook(
      beforeTransaction(h.db, parallel),
      await p(DANIEL),
      { groupId: "g-7b", subjectId: "M", term: 2, scale: "noten6" },
      TODAY,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      fieldErrors: { groupId: /schon ein Notenbuch/ },
    });
  });

  it("G5A-S02: kein Übertragen an sich selbst – Ziel-Liste ohne eigene Person; die bisherigen Lehrkräfte erfahren von einer Übertragung", async () => {
    const petra = await p(PETRA);
    expect(hasNotenbuchRight(petra, "notenbuch.transfer")).toBe(true);
    expect((await transferTargets(h.db, petra)).map((t) => t.id)).not.toContain(PETRA);
    await expect(transferBook(h.db, petra, bookId, { toTeacherId: PETRA })).rejects.toMatchObject({ fieldErrors: { toTeacherId: /an sich selbst/ } });
    expect(await getBook(h.db, petra, bookId)).toBeNull();
    await transferBook(h.db, petra, bookId, { toTeacherId: MURAT });
    const gong = await h.db.select().from(notifications).where(eq(notifications.moduleId, "notenbuch"));
    expect(gong.map((n) => n.userId).sort()).toEqual([DANIEL, TOBIAS].sort());
    expect(gong[0]!.title).toMatch(/Notenbuch übertragen: Klasse 7b/);
    expect(JSON.stringify(gong)).not.toMatch(/Mündlich|"value"/);
  });

  it("G5A-S03: Admin-Konten zählen nur `notenbuch.transfer` – auch nicht über eine selbst eingerichtete Gruppe", async () => {
    await h.db.insert(groups).values({ id: "g-x", name: "X", slug: "x", kind: "gremium" });
    await h.db.insert(grants).values([
      { permission: "notenbuch.term_view", groupId: "g-x" },
      { permission: "notenbuch.export", groupId: "g-x" },
      { permission: "notenbuch.own", groupId: "g-x" },
      { permission: "notenbuch.auskunft", groupId: "g-x" },
    ]);
    await h.db.insert(groupMembers).values({ groupId: "g-x", userId: ADMIN });
    const admin = await p(ADMIN);
    expect(admin.granted.has("notenbuch.term_view")).toBe(true);
    for (const r of ["notenbuch.term_view", "notenbuch.export", "notenbuch.own", "notenbuch.unlock", "notenbuch.auskunft"] as const) expect(hasNotenbuchRight(admin, r), r).toBe(false);
    expect(hasNotenbuchRight(admin, "notenbuch.transfer")).toBe(true);
    expect(await termOverview(h.db, admin, "g-7b")).toBeNull();
    expect(await handoverClasses(h.db, admin, "export")).toEqual([]);
    expect((await notenbuchAccess(h.db, admin)).termView).toBe(false);
    // dieselbe Gruppe wirkt für eine Lehrkraft (kein Admin-Konto) ganz normal
    await h.db.insert(groupMembers).values({ groupId: "g-x", userId: MURAT });
    expect(hasNotenbuchRight(await p(MURAT), "notenbuch.term_view")).toBe(true);
    await h.db.delete(groupMembers).where(eq(groupMembers.groupId, "g-x"));
  });

  it("G5A-C06/C12: Gruppe, Schuljahr und Fach mit Notenbüchern lassen sich nicht löschen – Hinweis statt Kaskade bzw. Fehler 500", async () => {
    const n = async () => (await h.db.select().from(notenbuchBooks).where(eq(notenbuchBooks.groupId, "g-7b"))).length;
    const before = await n();
    await expect(deleteGroup(h.db, ADMIN, "g-7b")).rejects.toMatchObject({ fieldErrors: { group: /Notenbüch.*archivieren/ } });
    expect(await h.db.select().from(groups).where(eq(groups.id, "g-7b"))).toHaveLength(1);
    expect(await n()).toBe(before);
    // Schuljahr ohne Gruppen, aber mit einem Buch (Löschfrist läuft)
    await h.db.insert(schoolYears).values({ id: "sj-alt", name: "2019/20", startsOn: "2019-08-01", endsOn: "2020-07-31", isCurrent: false });
    await h.db.insert(subjects).values({ id: "XY", name: "Auslaufendes Fach", color: "#123456", sortOrder: 99 });
    await h.db.insert(notenbuchBooks).values({ schoolYearId: "sj-alt", term: 1, groupId: "g-7b", subjectId: "XY", scale: "noten6", weights: {} });
    await expect(deleteSchoolYear(h.db, ADMIN, "sj-alt")).rejects.toMatchObject({ fieldErrors: { "name-sj-alt": /Notenbuch/ } });
    // Fach, das nur noch ein Notenbuch nutzt
    expect((await subjectUsage(h.db)).get("XY")).toBe(1);
    await expect(deleteSubject(h.db, ADMIN, "XY")).rejects.toMatchObject({ fieldErrors: { "code-XY": /Notenbuch/ } });
    expect(await h.db.select().from(subjects).where(eq(subjects.id, "XY"))).toHaveLength(1);
  });

  it("G5A-C07: Übergabeliste – zwei Bücher im selben Fach (Klasse und Förderkurs) sind zwei Spalten, keine Note verschwindet", () => {
    const row = (over: Partial<TermGradeRow>): TermGradeRow => ({
      studentId: LEA,
      subjectId: "E",
      subjectName: "Englisch",
      groupName: "Klasse 7b",
      schoolYearName: "2026/27",
      term: 1,
      computed: null,
      final: null,
      finalized: false,
      locked: false,
      ...over,
    });
    const { columns, cells } = handoverGrid("Klasse 7b", [
      row({ final: "3", finalized: true, locked: true }),
      row({ groupName: "Förderkurs E 7", computed: "2" }),
      row({ subjectId: "D", subjectName: "Deutsch", final: "2" }),
    ]);
    expect(columns.map((c) => [c.subjectId, c.groupName, c.locked])).toEqual([
      ["D", null, false],
      ["E", null, true],
      ["E", "Förderkurs E 7", false],
    ]);
    expect(cells.get(`${LEA}:E|Klasse 7b`)!.final).toBe("3");
    expect(cells.get(`${LEA}:E|Förderkurs E 7`)!.computed).toBe("2");
  });

  it("G5A-S08: Lese-Eintrag der Übergabeliste nennt Schuljahr und Halbjahr – je gelesenem Halbjahr ein Eintrag", async () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const jana = await p(JANA);
    await termOverview(h.db, jana, "g-7b", now, { schoolYearId: year!.id, term: 1 });
    await termOverview(h.db, jana, "g-7b", new Date(now.getTime() + 60_000), { schoolYearId: year!.id, term: 2 });
    await termOverview(h.db, jana, "g-7b", new Date(now.getTime() + 120_000), { schoolYearId: year!.id, term: 1 });
    const reads = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "lesen.notenbuch"), eq(auditLog.actorId, JANA)));
    expect(reads.map((r) => r.target).sort()).toEqual([`klasse:g-7b:${year!.id}:hj1`, `klasse:g-7b:${year!.id}:hj2`]);
    expect(reads.find((r) => r.target!.endsWith("hj2"))!.meta).toMatchObject({ schuljahr: year!.id, halbjahr: 2 });
  });
});
