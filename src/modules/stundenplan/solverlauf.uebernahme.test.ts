// Review-Fixes R1a (2026-10-26): Übernahme eines Solver-Laufs – Verlegung/Zusammenlegung im Rücknahme-Datensatz (A1),
// Übernahme nur im Planungszeitraum des Laufs (A2), Kalenderdaten (A12).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull, lte, or, gte, sql } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { timetableLessons, timetableSolverRuns, timetableSubstitutions } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { applyPreview, applyRun, createRun, executeRun, getRun, parseParams, planningPeriod, undoApply } from "./solverlauf";
import { createAssignment, listAssignments, planningYear, updateAssignment } from "./verteilung";

const today = "2026-10-05";
const settle = (h: DbHandle) => h.db.update(timetableSolverRuns).set({ status: "failed", finishedAt: new Date() }).where(sql`${timetableSolverRuns.status} in ('running', 'queued')`);

async function freshRun(h: DbHandle, opts: { refYmd?: string } = {}) {
  await settle(h);
  const id = await createRun(h.db, "u-admin", { seed: 7, effort: "schnell", ...opts }, today);
  expect(await executeRun(h.db, id, today, { sliceMs: 2 })).toBe("done");
  return id;
}

describe("planningPeriod (rein)", () => {
  const year = { startsOn: "2026-08-01", endsOn: "2027-07-31" };
  const a = (validFrom: string | null, validUntil: string | null) => ({ validFrom, validUntil });
  it("ohne Gültigkeiten: ganzes Schuljahr", () => {
    expect(planningPeriod("2026-10-05", year, [a(null, null), a(null, null)])).toEqual({ from: "2026-08-01", until: "2027-07-31" });
  });
  it("Halbjahre: 1. Hj. bis zum Vortag des nächsten unbekannten Auftrags, 2. Hj. ab dem Tag nach dem Ende des letzten unbekannten", () => {
    const list = [a(null, null), a(null, "2027-01-31"), a("2027-02-01", null)];
    expect(planningPeriod("2026-10-05", year, list)).toEqual({ from: "2026-08-01", until: "2027-01-31" });
    expect(planningPeriod("2027-02-01", year, list)).toEqual({ from: "2027-02-01", until: "2027-07-31" });
    // ein Auftrag, der endet, ohne dass einer nachkommt, begrenzt den Zeitraum nach hinten nicht (seine Stunden enden mit ihm)
    expect(planningPeriod("2026-10-05", year, [a(null, null), a(null, "2027-01-31")])).toEqual({ from: "2026-08-01", until: "2027-07-31" });
    // Epoche mitten im Jahr: davor und danach ist ein anderer Planungsstand
    expect(planningPeriod("2026-12-01", year, [a(null, null), a("2026-11-02", "2026-12-18")])).toEqual({ from: "2026-08-01", until: "2027-07-31" });
    expect(planningPeriod("2026-10-05", year, [a(null, null), a("2026-11-02", "2026-12-18")])).toEqual({ from: "2026-08-01", until: "2026-11-01" });
    expect(planningPeriod("2027-01-11", year, [a(null, null), a("2026-11-02", "2026-12-18")])).toEqual({ from: "2026-12-19", until: "2027-07-31" });
  });
});

describe("A12: Kalenderdaten", () => {
  it("Planungsstand 2027-02-30 ist ein Feldfehler", () => {
    expect(() => parseParams({ refYmd: "2027-02-30" })).toThrow(ValidationError);
  });
});

describe("A1: Verlegung und Zusammenlegung beim Übernehmen/Zurücknehmen", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Verlegung kommt mit Zielstunde zurück; Zusammenlegung in eine ersetzte Stunde wird gesichert, gezählt und mit aufnehmender Stunde wiederhergestellt", async () => {
    const from = "2026-11-09"; // Montag
    const lessons = await h.db.select().from(timetableLessons).where(and(isNull(timetableLessons.couplingId), eq(timetableLessons.weekday, 0), eq(timetableLessons.week, "all")));
    const moved = lessons.find((l) => l.groupId === "g-7b" && l.periodNr > 1)!;
    // Gast (fixiert → bleibt) und aufnehmende Stunde (wird ersetzt) zur selben Zeit in verschiedenen Gruppen
    const pairs = lessons.flatMap((g) => lessons.filter((x) => x.groupId !== g.groupId && x.periodNr === g.periodNr && x.id !== moved.id && g.id !== moved.id).map((x) => [g, x] as const));
    const [guest, host] = pairs[0]!;
    await h.db.update(timetableLessons).set({ fixed: true }).where(eq(timetableLessons.id, guest.id));
    await h.db.insert(timetableSubstitutions).values([
      { id: "s-move", lessonId: moved.id, date: from, kind: "move", targetPeriod: 1, createdBy: "u-admin" },
      { id: "s-merge", lessonId: guest.id, date: from, kind: "merge", mergeLessonId: host.id, createdBy: "u-admin" },
    ]);
    const id = await freshRun(h);
    expect((await getRun(h.db, id))!.stored!.keptLessonIds).toContain(guest.id);
    expect((await applyPreview(h.db, (await getRun(h.db, id))!, from))!.substitutions).toBe(2);

    const res = await applyRun(h.db, "u-admin", id, from, today);
    expect(res.removedSubstitutions).toBe(2);
    // nichts bleibt an einer Stunde hängen, die ab dem Stichtag nicht mehr gilt
    expect(await h.db.$count(timetableSubstitutions, inArray(timetableSubstitutions.id, ["s-move", "s-merge"]))).toBe(0);
    const undo = (await getRun(h.db, id))!.undo!;
    expect(undo.substitutions!.find((s) => s.id === "s-move")).toMatchObject({ kind: "move", targetPeriod: 1, mergeLessonId: null });
    expect(undo.substitutions!.find((s) => s.id === "s-merge")).toMatchObject({ kind: "merge", targetPeriod: null, mergeLessonId: host.id });

    const back = await undoApply(h.db, "u-admin", id, today);
    expect(back).toMatchObject({ restoredSubstitutions: 2, lostSubstitutions: 0 });
    const subs = new Map((await h.db.select().from(timetableSubstitutions).where(inArray(timetableSubstitutions.id, ["s-move", "s-merge"]))).map((s) => [s.id, s]));
    expect(subs.get("s-move")).toMatchObject({ lessonId: moved.id, kind: "move", targetPeriod: 1, mergeLessonId: null });
    expect(subs.get("s-merge")).toMatchObject({ lessonId: guest.id, kind: "merge", mergeLessonId: host.id });
    await h.db.delete(timetableSubstitutions).where(inArray(timetableSubstitutions.id, ["s-move", "s-merge"]));
    await h.db.update(timetableLessons).set({ fixed: false }).where(eq(timetableLessons.id, guest.id));
  }, 120_000);
});

describe("A2: Übernahme ersetzt nur den Planungszeitraum des Laufs", () => {
  let h: DbHandle;
  let year: NonNullable<Awaited<ReturnType<typeof planningYear>>>;
  beforeAll(async () => {
    h = await createSeededTestDb();
    year = (await planningYear(h.db))!;
    // Deutsch 7b nur im 1. Halbjahr, ab dem 2. Halbjahr ein neuer Auftrag
    const first = (await listAssignments(h.db, year.id)).find((a) => a.groups[0]?.id === "g-7b" && a.subjectId === "D" && !a.bandId)!;
    const base = { schoolYearId: year.id, groupId: "g-7b", subjectId: "D", hours: first.hours, teacherIds: first.teachers.map((t) => t.id), doubleLessons: first.doubleLessons, roomId: first.roomId, note: first.note };
    await updateAssignment(h.db, "u-admin", first.id, { ...base, validUntil: "2027-01-31" });
    await createAssignment(h.db, "u-admin", { ...base, hours: 2, doubleLessons: 0, validFrom: "2027-02-01" });
  });
  afterAll(() => h.close());

  const activeOn = (ymd: string) => and(lte(timetableLessons.validFrom, ymd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, ymd)));

  it("Lauf fürs 1. Hj. nach übernommenem 2. Hj.: Februar-Stunden bleiben, neue Stunden enden am 31.01.; Übernahme nach dem Zeitraum abgelehnt", async () => {
    const feb = await freshRun(h, { refYmd: "2027-02-01" });
    await applyRun(h.db, "u-admin", feb, "2027-02-01", today);
    const febLessons = await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, feb)).orderBy(timetableLessons.id);
    expect(febLessons.length).toBeGreaterThan(0);

    const sep = await freshRun(h);
    await expect(applyRun(h.db, "u-admin", sep, "2027-02-15", today)).rejects.toMatchObject({ fieldErrors: { from: expect.stringContaining("nur bis") } });
    expect((await applyPreview(h.db, (await getRun(h.db, sep))!, "2026-11-02"))!.until).toBe("2027-01-31");
    await applyRun(h.db, "u-admin", sep, "2026-11-02", today);
    // Februar-Plan unverändert
    expect(await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, feb)).orderBy(timetableLessons.id)).toEqual(febLessons);
    const sepLessons = await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, sep));
    expect(sepLessons.length).toBeGreaterThan(0);
    expect(sepLessons.every((l) => l.validFrom === "2026-11-02" && l.validUntil! <= "2027-01-31")).toBe(true);
    // am 15.02. gilt genau der Februar-Plan (plus fixierte/ohne Lehrauftrag)
    const onFeb = await h.db.select().from(timetableLessons).where(activeOn("2027-02-15"));
    expect(onFeb.filter((l) => l.solverRunId === sep)).toEqual([]);
    expect(onFeb.filter((l) => l.solverRunId === feb)).toHaveLength(febLessons.length);

    // Zurücknehmen stellt den Stand vor der zweiten Übernahme her
    await undoApply(h.db, "u-admin", sep, today);
    expect(await h.db.select().from(timetableLessons).where(eq(timetableLessons.solverRunId, feb)).orderBy(timetableLessons.id)).toEqual(febLessons);
    await undoApply(h.db, "u-admin", feb, today);
  }, 180_000);

  it("Lauf fürs 2. Hj. lässt sich nicht vor dem 01.02. übernehmen; laufende Stunden über das Zeitraumende werden geteilt, Vertretungen danach ziehen mit und kommen beim Zurücknehmen zurück", async () => {
    const before = await h.db.select().from(timetableLessons).orderBy(timetableLessons.id);
    const crossing = before.find((l) => !l.fixed && l.groupId === "g-9a" && l.validFrom < "2026-11-02" && (l.validUntil === null || l.validUntil > "2027-02-10"))!;
    expect(crossing).toBeDefined();
    await h.db.insert(timetableSubstitutions).values({ id: "s-feb", lessonId: crossing.id, date: "2027-02-10", kind: "cancel", note: "Februar" });

    const feb = await freshRun(h, { refYmd: "2027-02-01" });
    await expect(applyRun(h.db, "u-admin", feb, "2026-11-02", today)).rejects.toBeInstanceOf(ValidationError);

    const sep = await freshRun(h);
    // die Februar-Vertretung zieht mit und zählt nicht als entfallend
    const preview = (await applyPreview(h.db, (await getRun(h.db, sep))!, "2026-11-02"))!;
    const res = await applyRun(h.db, "u-admin", sep, "2026-11-02", today);
    expect(preview.substitutions).toBe(res.removedSubstitutions);
    expect((await getRun(h.db, sep))!.undo!.substitutions!.some((s) => s.id === "s-feb")).toBe(false);
    // die alte Stunde endet am Vortag; ab dem 01.02. gilt sie als Kopie weiter (bis ein Lauf fürs 2. Hj. übernommen wird)
    const [orig] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, crossing.id));
    expect(orig!.validUntil).toBe("2026-11-01");
    const copies = await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.groupId, crossing.groupId), eq(timetableLessons.weekday, crossing.weekday), eq(timetableLessons.periodNr, crossing.periodNr), eq(timetableLessons.validFrom, "2027-02-01")));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ subjectId: crossing.subjectId, teacherId: crossing.teacherId, roomId: crossing.roomId, validUntil: crossing.validUntil, solverRunId: crossing.solverRunId });
    const [sub] = await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.id, "s-feb"));
    expect(sub!.lessonId).toBe(copies[0]!.id);
    // am 15.02. gilt der alte Plan weiter, nicht der Lauf
    expect(await h.db.$count(timetableLessons, and(eq(timetableLessons.solverRunId, sep), activeOn("2027-02-15")))).toBe(0);

    await undoApply(h.db, "u-admin", sep, today);
    const after = await h.db.select().from(timetableLessons).orderBy(timetableLessons.id);
    expect(after.map((l) => [l.id, l.validFrom, l.validUntil])).toEqual(before.map((l) => [l.id, l.validFrom, l.validUntil]));
    const [subBack] = await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.id, "s-feb"));
    expect(subBack!.lessonId).toBe(crossing.id);
  }, 180_000);
});
