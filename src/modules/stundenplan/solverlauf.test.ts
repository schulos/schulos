import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbHandle } from "@/core/db/client";
import {
  auditLog,
  bookingResources,
  bookings,
  exams,
  groupMembers,
  groups,
  schoolYears,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  timetableSolverRuns,
  timetableSubstitutions,
} from "@/core/db/schema";
import { tryAcquire } from "@/core/jobs";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { createSeededTestDb, createTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  applyPreview,
  applyRun,
  canDeleteRun,
  cancelRun,
  cleanupRuns,
  createRun,
  deleteRun,
  executeQueued,
  executeRun,
  failInterruptedRuns,
  getRun,
  isUndoable,
  listRuns,
  parseParams,
  proposalDiagnosis,
  proposedLessons,
  reapStaleRuns,
  setFixed,
  undoApply,
  undoPreview,
  WEIGHT_PRESETS,
  type StoredResult,
} from "./solverlauf";
import { distribution, planningYear } from "./verteilung";

const today = "2026-10-05";
const settle = (db: Db) => db.update(timetableSolverRuns).set({ status: "failed", finishedAt: new Date() }).where(sql`${timetableSolverRuns.status} in ('running', 'queued')`);

describe("parseParams", () => {
  it("Vorgaben, Voreinstellungen, eigene Gewichte; ungültige Werte werden gemeldet", () => {
    expect(parseParams({})).toEqual({ effort: "normal", seed: 1, weights: WEIGHT_PRESETS.ausgewogen, preset: "ausgewogen" });
    expect(parseParams({ preset: "raumtreu", effort: "gruendlich", seed: 42 }).weights.noRoom).toBe(40);
    const own = parseParams({ preset: "eigene", weights: { teacherGap: 7, lateFrom: 5 } });
    expect(own.weights).toMatchObject({ teacherGap: 7, lateFrom: 5, classGap: 10 });
    // Voreinstellung ignoriert eigene Gewichte
    expect(parseParams({ preset: "ausgewogen", weights: { teacherGap: 99 } }).weights.teacherGap).toBe(3);
    expect(() => parseParams({ seed: 0 })).toThrow(ValidationError);
    expect(() => parseParams({ effort: "turbo" })).toThrow(ValidationError);
    expect(() => parseParams({ preset: "eigene", weights: { lateFrom: 5.5 } })).toThrow(ValidationError);
    expect(() => parseParams({ preset: "eigene", weights: { pref: -1 } })).toThrow(ValidationError);
  });
});

describe("Solver-Lauf (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("fixierte Stunde bleibt; Lauf mit Parametern, Protokoll, Kennzahlen, Vorschau, Diagnose, Übernahme ab Stichtag mit Herkunft", async () => {
    const year = (await planningYear(h.db))!;
    const before = await h.db.select().from(timetableLessons);
    const pin = before.find((l) => l.groupId === "g-7b" && l.subjectId === "D")!;
    await setFixed(h.db, "u-admin", pin.id, true);

    const id = await createRun(h.db, "u-admin", { seed: 3, effort: "schnell", label: "  Variante A  ", preset: "klassenkompakt" }, today);
    const queued = (await getRun(h.db, id))!;
    expect(queued).toMatchObject({ status: "queued", label: "Variante A", params: { effort: "schnell", seed: 3, preset: "klassenkompakt" }, cancelRequested: false });
    expect(queued.params!.weights.classGap).toBe(16);
    expect(queued.log.map((e) => e.kind)).toEqual(["queued"]);

    expect(await executeRun(h.db, id, today)).toBe("done");
    const run = (await getRun(h.db, id))!;
    expect(run).toMatchObject({ status: "done", progress: 100 });
    expect(run.heartbeatAt).toBeInstanceOf(Date);
    expect(run.stored!.result.unplaced).toEqual([]);
    expect(run.stored!.keptLessonIds).toContain(pin.id);
    // bandfähiges Format: jede Einheit hat genau einen Teil
    expect(run.stored!.units.every((u) => u.parts?.length === 1 && u.parts[0]!.groupIds.join() === u.groupIds.join())).toBe(true);
    // Kennzahlen klein neben dem Ergebnis, Protokoll mit Eingabe, Vorprüfung, Konstruktion, Zwischenständen und Ende
    expect(run.metrics).toMatchObject({ score: run.stored!.result.score, unplaced: 0, units: run.stored!.units.length, precheck: { errors: 0 } });
    expect(run.metrics!.durationMs).toBeGreaterThan(0);
    expect(run.metrics!.gaps.classTotal).toBeGreaterThanOrEqual(0);
    const kinds = run.log.map((e) => e.kind);
    for (const k of ["queued", "start", "input", "precheck", "construct", "progress", "done"]) expect(kinds).toContain(k);
    expect(run.log.find((e) => e.kind === "input")!.data).toMatchObject({ units: run.stored!.units.length, breakAfter: [2, 4, 6] });
    expect(run.log.length).toBeLessThanOrEqual(50);
    expect((await listRuns(h.db))[0]!.id).toBe(id);
    expect(await listRuns(h.db, { schoolYearId: year.id, status: "done" })).toHaveLength(1);
    expect(await listRuns(h.db, { status: ["failed", "cancelled"] })).toEqual([]);
    // Ergebnis gleich wie ein zweiter Lauf mit denselben Parametern (deterministisch, unabhängig von den Zeitscheiben)
    const twin = await createRun(h.db, "u-admin", { seed: 3, effort: "schnell", preset: "klassenkompakt" }, today);
    await executeRun(h.db, twin, today, { sliceMs: 2 });
    expect((await getRun(h.db, twin))!.stored!.result.placements).toEqual(run.stored!.result.placements);
    await deleteRun(h.db, "u-admin", twin);
    expect(await getRun(h.db, twin)).toBeNull();

    // Vorschau: so viele Stunden-Zeilen wie heute (die fixierte bleibt, ihr Auftrag hat eine Stunde weniger)
    const proposal = proposedLessons(run.stored!);
    expect(proposal.length + run.stored!.keptLessonIds.length).toBe(before.length);
    // nichts liegt auf dem Slot der fixierten Stunde in der 7b
    expect(proposal.some((l) => l.groupId === "g-7b" && l.weekday === pin.weekday && l.periodNr === pin.periodNr)).toBe(false);
    // Doppelstunden liegen nicht über der großen Pause (Demo-Raster: Pausen nach der 2., 4. und 6. Stunde)
    const doubles = run.stored!.units.filter((u) => u.length === 2);
    expect(doubles.length).toBeGreaterThan(0);
    const at = new Map(run.stored!.result.placements.map((p) => [p.unitId, p.periodNr]));
    expect(doubles.every((u) => ![2, 4, 6].includes(at.get(u.id)!))).toBe(true);
    const diag = await proposalDiagnosis(h.db, run.stored!);
    expect(diag.filter((f) => f.category === "gaps" && f.target.kind === "group").length).toBeLessThanOrEqual(3);

    await expect(applyRun(h.db, "u-admin", id, today, today)).rejects.toBeInstanceOf(ValidationError);
    // Stichtag muss ein Schultag sein (SP-09, L-08): Sonntag → Fehler mit dem nächsten Schultag
    await expect(applyRun(h.db, "u-admin", id, "2026-11-01", today)).rejects.toMatchObject({ fieldErrors: { from: expect.stringContaining("kein Schultag (Wochenende) – nächster Schultag: 2026-11-02") } });
    const from = "2026-11-02";
    const preview = (await applyPreview(h.db, run, from))!;
    expect(preview).toMatchObject({ from, ended: before.length - 1, deleted: 0, substitutions: 0, roomClashes: { bookings: 0, exams: 0 } });
    const res = await applyRun(h.db, "u-admin", id, from, today);
    expect(res).toMatchObject({ created: proposal.length, ended: before.length - 1, deleted: 0, removedSubstitutions: 0 });
    const applied = (await getRun(h.db, id))!;
    expect(applied).toMatchObject({ status: "applied", appliedFrom: from, appliedBy: "u-admin" });
    expect(applied.appliedAt).toBeInstanceOf(Date);
    expect(applied.log.at(-1)).toMatchObject({ kind: "apply", data: { from, created: res.created } });
    // Rücknahme-Daten: alle beendeten Stunden mit ihrem früheren Ende (SP-09)
    expect(applied.undo!.ended).toHaveLength(res.ended);
    expect(applied.undo!.ended.every((e) => e.validUntil === before[0]!.validUntil)).toBe(true);
    expect(applied.undo).toMatchObject({ deleted: [], removedSubstitutions: 0 });
    await expect(applyRun(h.db, "u-admin", id, from, today)).rejects.toBeInstanceOf(ValidationError);
    // Löschsperre: solange der Stichtag in der Zukunft liegt, nicht löschbar
    expect(isUndoable(applied, today)).toBe(true);
    expect(canDeleteRun(applied, today)).toBe(false);
    await expect(deleteRun(h.db, "u-admin", id, today)).rejects.toMatchObject({ fieldErrors: { run: expect.stringContaining("zurücknehmen") } });
    // Herkunft an den übernommenen Stunden; beim Löschen des Laufs bleibt die Stunde, die Herkunft wird leer
    expect(await h.db.$count(timetableLessons, eq(timetableLessons.solverRunId, id))).toBe(res.created);

    // bis zum Vortag gilt der alte Plan, ab Stichtag der neue – jeweils vollständig verplant
    const old = await distribution(h.db, year, "2026-10-30");
    const neu = await distribution(h.db, year, "2026-11-04");
    expect(old.assignments.every((a) => a.planned === a.hours)).toBe(true);
    expect(neu.assignments.every((a) => a.planned === a.hours)).toBe(true);
    expect(neu.unmatched).toEqual([]);
    const [pinned] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, pin.id));
    expect(pinned).toMatchObject({ fixed: true, validUntil: pin.validUntil });

    // ab dem Stichtag: nicht mehr zurücknehmbar, dafür löschbar; der Nachtjob leert die Rücknahme-Daten (Personenbezug)
    await expect(undoApply(h.db, "u-admin", id, from)).rejects.toMatchObject({ fieldErrors: { run: expect.stringContaining("nicht mehr zurücknehmen") } });
    expect(canDeleteRun(applied, from)).toBe(true);
    expect((await cleanupRuns(h.db, new Date("2026-11-02T03:00:00+01:00"))).undoCleared).toBe(1);
    expect((await getRun(h.db, id))!.undo).toBeNull();
    await deleteRun(h.db, "u-admin", id, from);
    expect(await h.db.$count(timetableLessons, eq(timetableLessons.solverRunId, id))).toBe(0);
    expect((await h.db.select().from(timetableLessons).where(eq(timetableLessons.validFrom, from))).length).toBe(res.created);
  }, 90_000);

  it("S79: Übernahme zurücknehmen bis zum Stichtag – alter Plan gilt wieder; Konflikte (veränderte, fremde, beendete Stunden, Vertretungen, Material, Buchungen, Klausuren) werden gezählt und erklärt", async () => {
    await settle(h.db);
    await h.db.delete(timetableLessons).where(sql`${timetableLessons.solverRunId} is not null`);
    const year = (await planningYear(h.db))!;
    const from = "2026-11-09"; // Montag
    const before = await h.db.select().from(timetableLessons).orderBy(timetableLessons.id);
    // Stunden, die am Stichtag gelten und nicht fixiert sind – die ersetzt die Übernahme (der erste Test hat den Plan ab 2026-11-02 übernommen)
    const active = before.filter((l) => !l.fixed && (l.validUntil === null || l.validUntil >= from));
    const lessonOn = (weekday: number) => active.find((l) => l.groupId === "g-7b" && l.weekday === weekday)!;
    // Randfälle vor der Übernahme: eine fixierte A-Wochen-Kopplung (bleibt), eine nicht fixierte A-Wochen-Stunde (wird ersetzt),
    // eine Stunde, die erst nach dem Stichtag beginnt (wird entfernt), und eine Vertretung am Stichtag (entfällt, kommt nicht zurück)
    const anchor = lessonOn(0);
    const couplingId = "k-undo";
    await h.db.insert(timetableLessons).values([
      { id: "l-ab-fix-1", groupId: "g-7a", weekday: 4, periodNr: 8, subjectId: "REL", teacherId: null, roomId: null, week: "A", validFrom: year.startsOn, validUntil: year.endsOn, couplingId, fixed: true },
      { id: "l-ab-fix-2", groupId: "g-7b", weekday: 4, periodNr: 8, subjectId: "REL", teacherId: null, roomId: null, week: "A", validFrom: year.startsOn, validUntil: year.endsOn, couplingId, fixed: true },
      { id: "l-ab-loose", groupId: "g-7b", weekday: 3, periodNr: 8, subjectId: "M", teacherId: anchor.teacherId, roomId: null, week: "A", validFrom: year.startsOn, validUntil: null },
      { id: "l-later", groupId: "g-7b", weekday: 2, periodNr: 8, subjectId: "M", teacherId: anchor.teacherId, roomId: "101", week: "all", validFrom: "2026-11-16", validUntil: year.endsOn },
    ]);
    await h.db.insert(timetableSubstitutions).values({ id: "s-stichtag", lessonId: anchor.id, date: from, kind: "cancel", note: "entfällt" });
    await h.db.insert(timetableSubstitutions).values({ id: "s-davor", lessonId: anchor.id, date: "2026-11-02", kind: "cancel" });

    const id = await createRun(h.db, "u-admin", { seed: 4, effort: "schnell" }, today);
    expect(await executeRun(h.db, id, today)).toBe("done");
    const run = (await getRun(h.db, id))!;
    expect(run.stored!.keptLessonIds).toEqual(expect.arrayContaining(["l-ab-fix-1", "l-ab-fix-2"]));
    expect(await applyPreview(h.db, run, from)).toMatchObject({ deleted: 1, substitutions: 1 });
    const res = await applyRun(h.db, "u-admin", id, from, today);
    expect(res).toMatchObject({ deleted: 1, removedSubstitutions: 1 });
    const applied = (await getRun(h.db, id))!;
    expect(applied.undo!.deleted).toEqual([{ id: "l-later", groupId: "g-7b", weekday: 2, periodNr: 8, subjectId: "M", teacherId: anchor.teacherId, roomId: "101", week: "all", validFrom: "2026-11-16", validUntil: year.endsOn, couplingId: null, fixed: false, solverRunId: null }]);
    expect(applied.undo!.ended.find((e) => e.id === "l-ab-loose")).toEqual({ id: "l-ab-loose", validUntil: null });
    expect(applied.undo!.ended.some((e) => e.id === "l-ab-fix-1")).toBe(false);
    expect(await h.db.$count(timetableSubstitutions, eq(timetableSubstitutions.id, "s-stichtag"))).toBe(0);
    expect(await h.db.$count(timetableSubstitutions, eq(timetableSubstitutions.id, "s-davor"))).toBe(1);
    // ohne Eingriffe: alles wiederherstellbar
    const clean = (await undoPreview(h.db, applied, today))!;
    expect(clean).toMatchObject({ lessons: res.created, changed: 0, substitutions: 0, classbook: 0, materials: 0, restorable: res.ended, notRestorable: 0, reinsert: 1, reinsertSkipped: 0, foreign: 0, lostSubstitutions: 1, roomClashes: { bookings: 0, exams: 0 } });
    expect(await undoPreview(h.db, applied, from)).toBeNull();

    // Eingriffe nach der Übernahme: Stunde des Laufs fixiert, Vertretung an einer Lauf-Stunde, Stunde von Hand angelegt, eine beendete
    // Stunde von Hand verändert, eine gelöscht; Raumbuchung und Klausur in einem Raum, den der alte Plan am Stichtag belegt
    const own = await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, id));
    const ownMonday = own.find((l) => l.weekday === 0)!;
    await setFixed(h.db, "u-admin", own[0]!.id, true);
    await h.db.insert(timetableSubstitutions).values({ lessonId: ownMonday.id, date: from, kind: "cancel" });
    await h.db.insert(timetableLessons).values({ id: "l-foreign", groupId: "g-7b", weekday: 1, periodNr: 8, subjectId: "M", teacherId: anchor.teacherId, week: "all", validFrom: "2026-11-23", validUntil: year.endsOn });
    const endedA = active.find((l) => l.groupId === "g-9a")!;
    const endedB = active.find((l) => l.groupId === "g-9b")!;
    await h.db.update(timetableLessons).set({ validUntil: "2026-12-18" }).where(eq(timetableLessons.id, endedA.id));
    await h.db.delete(timetableLessons).where(eq(timetableLessons.id, endedB.id));
    const oldMonday = active.find((l) => l.weekday === 0 && l.roomId && l.id !== endedA.id && l.id !== endedB.id)!;
    // der Raum kann in der Demo schon buchbar sein – dann die vorhandene Ressource nehmen
    const [existingResource] = await h.db.select({ id: bookingResources.id }).from(bookingResources).where(eq(bookingResources.roomId, oldMonday.roomId!));
    const resourceId = existingResource?.id ?? "br-undo";
    if (!existingResource) await h.db.insert(bookingResources).values({ id: resourceId, kind: "room", roomId: oldMonday.roomId!, name: "Raum" });
    await h.db.insert(bookings).values({ resourceId, date: from, periodNr: oldMonday.periodNr }).onConflictDoNothing();
    await h.db.insert(bookings).values({ resourceId, date: "2026-11-02", periodNr: oldMonday.periodNr }).onConflictDoNothing(); // vor dem Stichtag: zählt nicht
    await h.db.insert(exams).values({ groupId: "g-9a", subjectId: "M", kind: "klassenarbeit", title: "KA", date: from, periodFrom: oldMonday.periodNr, periodTo: oldMonday.periodNr, roomId: oldMonday.roomId });
    const dirty = (await undoPreview(h.db, applied, today))!;
    expect(dirty).toMatchObject({ lessons: res.created, changed: 1, substitutions: 1, restorable: res.ended - 2, notRestorable: 2, reinsert: 1, foreign: 1, lostSubstitutions: 1 });
    expect(dirty.roomClashes.bookings).toBeGreaterThanOrEqual(1);
    expect(dirty.roomClashes.exams).toBeGreaterThanOrEqual(1);

    // Zurücknehmen: nur eigene Stunden weg, beendete wieder verlängert (bis auf die zwei veränderten), entfernte wieder da, fremde bleiben
    await expect(undoApply(h.db, "u-admin", id, from)).rejects.toBeInstanceOf(ValidationError);
    const undone = await undoApply(h.db, "u-admin", id, today);
    expect(undone).toMatchObject({ lessons: res.created, changed: 1, substitutions: 1, restorable: res.ended - 2, notRestorable: 2, reinsert: 1, foreign: 1 });
    expect(await h.db.$count(timetableLessons, eq(timetableLessons.solverRunId, id))).toBe(0);
    const after = new Map((await h.db.select().from(timetableLessons)).map((l) => [l.id, l]));
    for (const l of before) {
      if (l.id === endedB.id) expect(after.has(l.id)).toBe(false);
      else if (l.id === endedA.id) expect(after.get(l.id)!.validUntil).toBe("2026-12-18");
      else expect(after.get(l.id)).toMatchObject({ validUntil: l.validUntil, weekday: l.weekday, periodNr: l.periodNr, teacherId: l.teacherId, roomId: l.roomId });
    }
    expect(after.get("l-ab-loose")).toMatchObject({ validUntil: null, week: "A" });
    expect(after.get("l-later")).toMatchObject({ validFrom: "2026-11-16", roomId: "101", solverRunId: null });
    expect(after.get("l-foreign")).toBeTruthy();
    expect(after.get("l-ab-fix-1")).toMatchObject({ fixed: true, validUntil: year.endsOn });
    const back = (await getRun(h.db, id))!;
    expect(back).toMatchObject({ status: "done", appliedFrom: null, appliedBy: null, appliedAt: null, undo: null });
    expect(back.log.at(-1)).toMatchObject({ kind: "undo", data: { lessons: res.created, notRestorable: 2 } });
    expect(back.log.at(-1)!.text).toContain("2 nicht mehr wiederherstellbar");
    await expect(undoApply(h.db, "u-admin", id, today)).rejects.toMatchObject({ fieldErrors: { run: "Dieser Lauf ist nicht übernommen" } });
    // Audit für Übernahme und Rücknahme
    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog).where(sql`${auditLog.meta} ->> 'run' = ${id}`)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["stundenplan.solver.apply", "stundenplan.solver.undo"]));
    // wieder „fertig“: erneut übernehmbar, dann sofort löschbar, sobald die Rücknahme zurückgenommen … bzw. nach dem Stichtag
    await applyRun(h.db, "u-admin", id, from, today);
    expect(canDeleteRun((await getRun(h.db, id))!, today)).toBe(false);
    await undoApply(h.db, "u-admin", id, today);
    await deleteRun(h.db, "u-admin", id, today);
    expect(await getRun(h.db, id)).toBeNull();
    // aufräumen, damit die folgenden Tests den Demo-Plan vorfinden
    await h.db.delete(timetableLessons).where(inArray(timetableLessons.id, ["l-ab-fix-1", "l-ab-fix-2", "l-ab-loose", "l-later", "l-foreign"]));
    await h.db.delete(bookings).where(and(eq(bookings.resourceId, resourceId), inArray(bookings.date, [from, "2026-11-02"])));
    await h.db.delete(bookingResources).where(eq(bookingResources.id, "br-undo"));
    await h.db.delete(exams).where(and(eq(exams.groupId, "g-9a"), eq(exams.date, from)));
    await h.db.delete(timetableSubstitutions).where(eq(timetableSubstitutions.id, "s-davor"));
    await h.db.update(timetableLessons).set({ validUntil: endedA.validUntil }).where(eq(timetableLessons.id, endedA.id));
    await h.db.insert(timetableLessons).values({ ...endedB });
  }, 120_000);

  it("Raum je Kopplungsteil (SP-G-02): geteilte Klasse mit zwei Lehrkräften bekommt zwei Sporthallen – bis in die Übernahme als Kopplung", async () => {
    await settle(h.db);
    const year = (await planningYear(h.db))!;
    const [sp] = await h.db
      .select({ id: timetableAssignments.id })
      .from(timetableAssignments)
      .innerJoin(timetableAssignmentGroups, eq(timetableAssignmentGroups.assignmentId, timetableAssignments.id))
      .where(and(eq(timetableAssignmentGroups.groupId, "g-7b"), eq(timetableAssignments.subjectId, "SP")));
    expect(sp).toBeTruthy();
    const plannedBefore = (await distribution(h.db, year, "2026-11-04")).assignments.map((a) => [a.id, a.planned]);
    const [teacher] = await h.db.select({ teacherId: timetableAssignmentTeachers.teacherId }).from(timetableAssignmentTeachers).where(eq(timetableAssignmentTeachers.assignmentId, sp!.id));
    await h.db.insert(timetableAssignmentTeachers).values({ assignmentId: sp!.id, teacherId: "u-frank.schulte" });
    const id = await createRun(h.db, "u-admin", { seed: 8, effort: "schnell" }, today);
    expect(await executeRun(h.db, id, today)).toBe("done");
    const run = (await getRun(h.db, id))!;
    const units = run.stored!.units.filter((u) => u.parts![0]!.assignmentId === sp!.id);
    expect(units.length).toBeGreaterThan(0);
    expect(units[0]!.parts!.map((p) => p.teacherIds)).toEqual([[teacher!.teacherId], ["u-frank.schulte"]]);
    const placements = run.stored!.result.placements.filter((p) => units.some((u) => u.id === p.unitId));
    expect(placements.length).toBe(units.length);
    for (const p of placements) {
      expect(p.roomIds).toHaveLength(2);
      expect(p.roomIds!.every((r) => r !== null)).toBe(true);
      expect(new Set(p.roomIds).size).toBe(2);
      expect(p.roomId).toBe(p.roomIds![0]);
    }
    // die Demo hat zwei Sporthallen – mindestens eine Sportstunde der 7b liegt in beiden
    expect(placements.some((p) => p.roomIds!.includes("TH1") && p.roomIds!.includes("TH2"))).toBe(true);
    const rows = proposedLessons(run.stored!).filter((l) => l.groupId === "g-7b" && l.subjectId === "SP");
    expect(rows.every((l) => l.coupled)).toBe(true);
    expect(rows.length).toBe(2 * units.reduce((s, u) => s + u.length, 0));
    const from = "2026-11-02";
    await applyRun(h.db, "u-admin", id, from, today);
    const lessons = await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.solverRunId, id), eq(timetableLessons.groupId, "g-7b"), eq(timetableLessons.subjectId, "SP")));
    expect(lessons.length).toBe(rows.length);
    const bySlot = new Map<string, typeof lessons>();
    for (const l of lessons) bySlot.set(`${l.weekday}-${l.periodNr}`, [...(bySlot.get(`${l.weekday}-${l.periodNr}`) ?? []), l]);
    for (const slot of bySlot.values()) {
      expect(slot).toHaveLength(2);
      expect(slot[0]!.couplingId).toBe(slot[1]!.couplingId);
      expect(slot[0]!.couplingId).not.toBeNull();
      expect(slot[0]!.roomId).not.toBe(slot[1]!.roomId);
      expect(slot.map((l) => l.teacherId).sort()).toEqual([teacher!.teacherId, "u-frank.schulte"].sort());
    }
    // zurück auf den Demo-Stand
    await undoApply(h.db, "u-admin", id, today);
    await deleteRun(h.db, "u-admin", id, today);
    await h.db.delete(timetableAssignmentTeachers).where(and(eq(timetableAssignmentTeachers.assignmentId, sp!.id), eq(timetableAssignmentTeachers.teacherId, "u-frank.schulte")));
    // Zurücknehmen stellt die Verteilung von vorher wieder her
    expect((await distribution(h.db, year, "2026-11-04")).assignments.map((a) => [a.id, a.planned])).toEqual(plannedBefore);
  }, 90_000);

  it("Warteschlange: zwei Läufe → der ältere rechnet zuerst, der zweite wartet und startet danach; fremde Sperre → nichts passiert", async () => {
    await settle(h.db);
    const a = await createRun(h.db, "u-admin", { seed: 1, effort: "schnell" }, today);
    const b = await createRun(h.db, "u-admin", { seed: 2, effort: "schnell" }, today);
    expect((await getRun(h.db, b))!.status).toBe("queued");
    // ein anderer Prozess hält die Sperre: die Warteschlange wartet
    expect(await tryAcquire(h.db, "solver", "anderer-prozess", 60_000, new Date())).toBe(true);
    expect(await executeQueued(h.db, today)).toEqual({ ran: false, executed: [] });
    expect((await getRun(h.db, a))!.status).toBe("queued");
    // Sperre weg → beide nacheinander, in Reihenfolge
    await h.db.execute(sql`update system_jobs set locked_until = null, locked_by = null where name = 'solver'`);
    const r = await executeQueued(h.db, today);
    expect(r).toEqual({ ran: true, executed: [a, b] });
    expect((await getRun(h.db, a))!.status).toBe("done");
    expect((await getRun(h.db, b))!.status).toBe("done");
    expect(await executeQueued(h.db, today)).toEqual({ ran: false, executed: [] });
  }, 90_000);

  it("Abbruch: wartend → cancelled sofort; während der Konstruktion → cancelled ohne Ergebnis; danach → done, vorzeitig beendet", async () => {
    await settle(h.db);
    const q = await createRun(h.db, "u-admin", { seed: 5 }, today);
    expect(await cancelRun(h.db, "u-admin", q)).toBe("cancelled");
    expect(await getRun(h.db, q)).toMatchObject({ status: "cancelled", stored: null });
    expect((await getRun(h.db, q))!.finishedAt).toBeInstanceOf(Date);
    await expect(cancelRun(h.db, "u-admin", q)).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteRun(h.db, "u-admin", "gibts-nicht")).rejects.toBeInstanceOf(ValidationError);

    // Abbruch während der Konstruktion: Wunsch vor dem ersten Heartbeat setzen, Heartbeat sofort → cancelled
    const c = await createRun(h.db, "u-admin", { seed: 6, effort: "gruendlich" }, today);
    let asked = false;
    const resC = await executeRun(h.db, c, today, {
      sliceMs: 1,
      heartbeatMs: 0,
      onSlice: async (phase) => {
        if (phase === "construct" && !asked) {
          asked = true;
          await h.db.update(timetableSolverRuns).set({ cancelRequested: true }).where(eq(timetableSolverRuns.id, c));
        }
      },
    });
    expect(resC).toBe("cancelled");
    const cancelled = (await getRun(h.db, c))!;
    expect(cancelled).toMatchObject({ status: "cancelled", stored: null, metrics: null });
    expect(cancelled.log.at(-1)).toMatchObject({ kind: "cancel" });
    expect(cancelled.progress).toBeLessThan(30);

    // Abbruch in der Verbesserung: gültiger Plan, done mit Vermerk
    const d = await createRun(h.db, "u-admin", { seed: 6, effort: "gruendlich" }, today);
    let improving = 0;
    const resD = await executeRun(h.db, d, today, {
      sliceMs: 5,
      heartbeatMs: 0,
      onSlice: async (phase) => {
        if (phase === "improve" && ++improving === 3) await cancelRun(h.db, "u-admin", d);
      },
    });
    expect(resD).toBe("done");
    const early = (await getRun(h.db, d))!;
    expect(early.status).toBe("done");
    expect(early.metrics!.cancelledAt).toBeGreaterThanOrEqual(30);
    expect(early.metrics!.cancelledAt).toBeLessThan(95);
    expect(early.metrics!.steps).toBeLessThan(early.iterations);
    expect(early.log.some((e) => e.kind === "cancel" && /vorzeitig beendet bei \d+ %/i.test(e.text))).toBe(true);
    expect(early.stored!.result.unplaced).toEqual([]);
    expect(proposedLessons(early.stored!).length).toBeGreaterThan(0);
  }, 90_000);

  it("Serverneustart bricht rechnende Läufe ab; verwaiste Läufe ohne Heartbeat werden eingesammelt; frische bleiben", async () => {
    await settle(h.db);
    const b = await createRun(h.db, "u-admin", { seed: 2 }, today);
    await h.db.update(timetableSolverRuns).set({ status: "running", heartbeatAt: new Date() }).where(eq(timetableSolverRuns.id, b));
    expect(await reapStaleRuns(h.db, new Date())).toBe(0);
    expect(await reapStaleRuns(h.db, new Date(Date.now() + 6 * 60_000))).toBe(1);
    expect(await getRun(h.db, b)).toMatchObject({ status: "failed", error: expect.stringContaining("keine Rückmeldung") });

    const c = await createRun(h.db, "u-admin", { seed: 2 }, today);
    await h.db.update(timetableSolverRuns).set({ status: "running" }).where(eq(timetableSolverRuns.id, c));
    expect(await failInterruptedRuns(h.db)).toBe(1);
    expect(await getRun(h.db, c)).toMatchObject({ status: "failed", error: "Abgebrochen: Der Server wurde neu gestartet" });
    // ein Lauf, der schon fertig ist, wird nicht noch einmal gerechnet
    expect(await executeRun(h.db, c, today)).toBe("skipped");
  });

  it("Validierung vor dem Start: Warnung für Kurse ohne Mitglieder im Protokoll; ohne Lehraufträge kein Lauf", async () => {
    await settle(h.db);
    const year = (await planningYear(h.db))!;
    // Kurs mit Lehrauftrag, dessen Mitglieder fehlen → Warnung
    const [kurs] = await h.db.select({ id: groups.id }).from(groups).where(eq(groups.kind, "kurs")).limit(1);
    const members = await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, kurs!.id));
    await h.db.delete(groupMembers).where(eq(groupMembers.groupId, kurs!.id));
    const id = await createRun(h.db, "u-admin", { seed: 1 }, today);
    const run = (await getRun(h.db, id))!;
    expect(run.log.some((e) => e.kind === "warning" && /Kurs(e)? mit Lehrauftrag ohne Mitglieder/.test(e.text))).toBe(true);
    await h.db.insert(groupMembers).values(members);
    await cancelRun(h.db, "u-admin", id);

    // leere Instanz mit Schuljahr: ohne Zeitraster, Lehraufträge und Räume kein Lauf, sondern Hinweise (L-02)
    const empty = await createTestDb();
    try {
      await empty.db.insert(schoolYears).values({ id: "sj", name: "2026/27", startsOn: year.startsOn, endsOn: year.endsOn, isCurrent: true });
      await expect(createRun(empty.db, "u-admin", { seed: 1 }, today)).rejects.toMatchObject({
        fieldErrors: { periods: expect.stringContaining("Zeitraster"), assignments: expect.stringContaining("Lehraufträge"), rooms: expect.stringContaining("Räume") },
      });
      expect(await empty.db.$count(timetableSolverRuns)).toBe(0);
    } finally {
      await empty.close();
    }
  }, 60_000);

  it("Aufräumen: fehlgeschlagene ohne Ergebnis nach 7 Tagen weg, ab dem 21. fertigen Lauf je Schuljahr nur noch Kennzahlen; übernommene bleiben", async () => {
    await settle(h.db);
    await h.db.delete(timetableSolverRuns);
    const year = (await planningYear(h.db))!;
    const now = new Date("2026-10-19T03:00:00Z");
    const stored: StoredResult = { result: { placements: [], unplaced: [], score: 1, breakdown: { pref: 0, teacherGap: 0, classGap: 0, subjectTwice: 0, roomWish: 0, noRoom: 0, late: 0 }, items: [], stats: { units: 0, iterations: 0, improved: 0 }, gaps: { teacherTotal: 0, teacherMax: 0, classTotal: 0, classMax: 0 } }, units: [], keptLessonIds: [], refYmd: today };
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    await h.db.insert(timetableSolverRuns).values([
      { id: "old-failed", schoolYearId: year.id, status: "failed", createdAt: days(8) },
      { id: "new-failed", schoolYearId: year.id, status: "failed", createdAt: days(6) },
      { id: "old-cancelled", schoolYearId: year.id, status: "cancelled", createdAt: days(30) },
      { id: "applied", schoolYearId: year.id, status: "applied", createdAt: days(400), result: stored },
      // SP-09: Rücknahme-Daten bleiben nur, solange der Stichtag in der Zukunft liegt
      { id: "applied-past", schoolYearId: year.id, status: "applied", createdAt: days(10), appliedFrom: "2026-10-19", result: stored, undo: { ended: [], deleted: [], removedSubstitutions: 0 } },
      { id: "applied-future", schoolYearId: year.id, status: "applied", createdAt: days(1), appliedFrom: "2026-11-02", result: stored, undo: { ended: [], deleted: [], removedSubstitutions: 0 } },
      ...Array.from({ length: 23 }, (_, i) => ({ id: `done-${String(i).padStart(2, "0")}`, schoolYearId: year.id, status: "done" as const, createdAt: days(i + 1), result: stored, metrics: { score: i } })),
    ]);
    expect(await cleanupRuns(h.db, now)).toEqual({ deleted: 2, trimmed: 3, undoCleared: 1 });
    const all = await h.db.select().from(timetableSolverRuns);
    expect(all.map((r) => r.id).sort()).not.toContain("old-failed");
    expect(all.map((r) => r.id)).toContain("new-failed");
    expect(all.find((r) => r.id === "applied")!.result).not.toBeNull();
    expect(all.find((r) => r.id === "applied-past")!.undo).toBeNull();
    expect(all.find((r) => r.id === "applied-future")!.undo).not.toBeNull();
    const trimmed = all.filter((r) => r.status === "done" && r.result === null).map((r) => r.id).sort();
    expect(trimmed).toEqual(["done-20", "done-21", "done-22"]);
    const t = (await getRun(h.db, "done-22"))!;
    expect(t.metrics).toEqual({ score: 22 });
    expect(t.log.at(-1)).toMatchObject({ kind: "cleanup" });
    await expect(applyRun(h.db, "u-admin", "done-22", "2026-11-02", today)).rejects.toMatchObject({ fieldErrors: { run: expect.stringContaining("Aufräumen") } });
    // zweiter Lauf ändert nichts mehr; der Nachtjob ist eingeplant
    expect(await cleanupRuns(h.db, now)).toEqual({ deleted: 0, trimmed: 0, undoCleared: 0 });
    const job = SCHEDULED_JOBS.find((j) => j.name === "solver-aufraeumen")!;
    expect(job).toMatchObject({ at: "03:00", until: "06:00" });
    expect(await job.run(h.db, now)).toEqual({ deleted: 0, trimmed: 0, undoCleared: 0 });
    // Läufe vor SP-06 (ohne Teile, ohne Parameter) bleiben lesbar
    const legacy = (await getRun(h.db, "done-00"))!;
    expect(legacy).toMatchObject({ params: null, log: [], label: null, cancelRequested: false });
    expect(proposedLessons({ ...stored, result: { ...stored.result, placements: [{ unitId: "u", weekday: 0, periodNr: 1, roomId: null }] }, units: [{ id: "u", label: "7a M", groupIds: ["7a"], teacherIds: ["t"], subjectId: "M", length: 2 }] })).toEqual([
      { unitId: "u@0", groupId: "7a", subjectId: "M", teacherId: "t", roomId: null, weekday: 0, periodNr: 1, coupled: false },
      { unitId: "u@1", groupId: "7a", subjectId: "M", teacherId: "t", roomId: null, weekday: 0, periodNr: 2, coupled: false },
    ]);
  });
});
