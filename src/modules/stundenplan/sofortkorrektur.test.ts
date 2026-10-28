// SP3-05 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.4, F-10-2, R3): Sofort-Korrekturen am gültigen Plan – Regeln rein (`planUnit`) und auf der
// Demo-Schule: Split ab dem nächsten Schultag (Klassenbuch-Einträge und Vertretungen davor bleiben, danach ziehen sie um), in place nur
// ohne Vergangenheitsbezug, Protokoll, Gong genau einmal (Lehrkräfte sofort, Schüler:innen zur Vortags-Uhrzeit), Schülersicht, Hinweis ab
// 10 geänderten Stunden, offene Entwürfe ziehen nach (R3) und Kontolöschung bereinigt das Protokoll.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import {
  classbookEntries,
  notifications,
  timetableAbsenceMaterials,
  timetableDraftLessons,
  timetableLessons,
  timetablePlanChanges,
  timetableSubstitutionChanges,
  timetableSubstitutions,
  type TimetableLesson,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteAccounts } from "@/core/privacy/konto";
import { addDays, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { createLesson, deleteCoupling, deleteLesson, findCollisions, saveCoupling, updateLesson, type LessonInput } from "./manage";
import { loadPlanDiff } from "./plan-diff";
import { LIVE } from "./plan-quelle";
import { approveVersion, submitForReview, type Viewer } from "./planpruefung";
import { createDraft, validVersion } from "./planversionen";
import { listSlots } from "./service";
import { moveGridInput, moveLesson, movePlacement, placementGrid } from "./setzhilfe";
import {
  correctionBundleKey,
  correctionFrom,
  correctionsSince,
  correctionSummary,
  FOLLOW_UP_HINT,
  planUnit,
  runPlanChangeNotifications,
  type UnitBefore,
} from "./sofortkorrektur";
import { publishVersion } from "./veroeffentlichen";

const errorOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0]!;
    throw err;
  }
  throw new Error("keine ValidationError");
};

describe("planUnit (rein)", () => {
  const b: UnitBefore = { id: "l1", groupId: "g", subjectId: "D", teacherId: "t1", roomId: "106", weekday: 0, periodNr: 5, week: "all", validFrom: "2026-08-01", validUntil: null, couplingId: null, fixed: true, solverRunId: "r1" };
  const ids = (() => {
    let n = 0;
    return () => `n${++n}`;
  })();
  const base = { today: "2026-10-05", from: "2026-10-06", coupled: false };

  it("ohne Vergangenheitsbezug in place, laufend als Split ab dem Stichtag", () => {
    const inplace = planUnit({ ...base, before: [b], after: [{ ...b, roomId: "105" }], noPast: true }, ids);
    expect(inplace).toMatchObject({ mode: "inplace", updates: [{ id: "l1", set: { roomId: "105" } }], ends: [], inserts: [] });
    expect(inplace.changes).toEqual([expect.objectContaining({ kind: "inplace", lessonId: "l1", validFrom: "2026-10-05" })]);

    const split = planUnit({ ...base, before: [b], after: [{ ...b, roomId: "105" }], noPast: false }, ids);
    expect(split).toMatchObject({ mode: "split", cut: "2026-10-06", ends: ["l1"], updates: [], deletes: [] });
    expect(split.inserts).toEqual([expect.objectContaining({ roomId: "105", validFrom: "2026-10-06", validUntil: null, fixed: true, solverRunId: "r1", predecessorId: "l1", couplingId: null })]);
    expect(split.changes).toEqual([expect.objectContaining({ kind: "split", lessonId: "l1", successorId: split.inserts[0]!.id, validFrom: "2026-10-06" })]);
    // späterer Beginn aus der Eingabe verschiebt den Stichtag
    expect(planUnit({ ...base, before: [b], after: [{ ...b, roomId: "105", validFrom: "2026-11-02" }], noPast: false }, ids).cut).toBe("2026-11-02");
  });

  it("laufend: nur das Ende verschieben geht in place, der Beginn nicht; unverändert bleibt alles", async () => {
    expect(planUnit({ ...base, before: [b], after: [{ ...b }], noPast: false }, ids).mode).toBe("noop");
    const end = planUnit({ ...base, before: [b], after: [{ ...b, validUntil: "2027-01-31" }], noPast: false }, ids);
    expect(end).toMatchObject({ mode: "inplace", updates: [{ id: "l1", set: { validUntil: "2027-01-31" } }] });
    expect(await errorOf(() => planUnit({ ...base, before: [b], after: [{ ...b, validFrom: "2026-09-01" }], noPast: false }, ids))).toMatch(/Beginn lässt sich nicht mehr ändern/);
    expect(await errorOf(() => planUnit({ ...base, before: [b], after: [{ ...b, validUntil: "2026-10-01" }], noPast: false }, ids))).toMatch(/Frühestens bis heute/);
    // endet die Stunde vor dem Stichtag, wirkt eine Änderung nicht mehr
    expect(await errorOf(() => planUnit({ ...base, before: [{ ...b, validUntil: "2026-10-05" }], after: [{ ...b, validUntil: "2026-10-05", roomId: "105" }], noPast: false }, ids))).toMatch(/wirkt nicht mehr/);
  });

  it("entfällt: laufend endet am Vortag, ohne Vergangenheitsbezug ganz", () => {
    expect(planUnit({ ...base, before: [b], after: [], noPast: false }, ids)).toMatchObject({ mode: "split", ends: ["l1"], inserts: [], changes: [{ kind: "delete", lessonId: "l1", validFrom: "2026-10-06" }] });
    expect(planUnit({ ...base, before: [b], after: [], noPast: true }, ids)).toMatchObject({ mode: "inplace", deletes: ["l1"], changes: [{ kind: "delete", lessonId: "l1" }] });
  });

  it("Kopplung als Einheit: ändert sich ein Teil, enden alle und gelten ab dem Stichtag mit neuer gemeinsamer Kopplungs-id", () => {
    const p1 = { ...b, id: "k1", couplingId: "c" };
    const p2 = { ...b, id: "k2", subjectId: "REL", teacherId: "t2", roomId: "110", couplingId: "c" };
    const p3 = { ...b, id: "k3", subjectId: "PL", teacherId: "t3", roomId: "111", couplingId: "c" };
    const plan = planUnit({ ...base, coupled: true, before: [p1, p2, p3], after: [{ ...p1, roomId: "105" }, { ...p2 }, { ...p1, id: undefined, subjectId: "KU" }], noPast: false }, ids);
    expect(plan.ends.sort()).toEqual(["k1", "k2", "k3"]);
    expect(new Set(plan.inserts.map((i) => i.couplingId)).size).toBe(1);
    expect(plan.inserts[0]!.couplingId).not.toBe("c");
    expect(plan.changes.map((c) => c.kind).sort()).toEqual(["create", "delete", "split", "split"]);
    // bleibt nur ein Teil, ist es keine Kopplung mehr
    const single = planUnit({ ...base, coupled: true, before: [p1, p2], after: [{ ...p1 }], noPast: false }, ids);
    expect(single.inserts).toEqual([expect.objectContaining({ couplingId: null, predecessorId: "k1" })]);
  });
});

describe("Sofort-Korrektur im gültigen Plan (SP3-05, Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05"; // Montag
  const now = new Date("2026-10-05T08:00:00Z"); // 10:00 Berlin
  const PLANER = "u-frank.schulte";
  const opts = (batchId?: string, extra: { reason?: string } = {}) => ({ today, now, batchId, ...extra });
  let from: string;
  let monAfter: string; // erster Montag ab dem Stichtag

  beforeAll(async () => {
    h = await createSeededTestDb();
    from = await correctionFrom(h.db, today);
    monAfter = from;
    while (weekdayMon0(monAfter) !== 0) monAfter = addDays(monAfter, 1);
  }, 120_000);
  afterAll(() => h.close());

  const lessonOf = async (group: string, weekday: number, period: number): Promise<TimetableLesson> =>
    (
      await h.db
        .select()
        .from(timetableLessons)
        .where(and(eq(timetableLessons.groupId, group), eq(timetableLessons.weekday, weekday), eq(timetableLessons.periodNr, period)))
        .orderBy(asc(timetableLessons.validFrom), asc(timetableLessons.id))
    ).find((l) => l.validFrom <= today && (l.validUntil === null || l.validUntil >= from))!;
  const inputOf = (l: TimetableLesson, patch: Partial<LessonInput> = {}): LessonInput => ({
    groupId: l.groupId,
    weekday: l.weekday,
    periodNr: l.periodNr,
    subjectId: l.subjectId,
    teacherId: l.teacherId,
    roomId: l.roomId,
    week: l.week,
    validFrom: l.validFrom,
    validUntil: l.validUntil,
    ...patch,
  });
  const row = async (id: string) => (await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, id)))[0];
  const successorOf = async (batchId: string, lessonId: string) =>
    (await h.db.select().from(timetablePlanChanges).where(and(eq(timetablePlanChanges.batchId, batchId), eq(timetablePlanChanges.lessonId, lessonId))))[0]!.successorId!;
  const gongs = async (userId: string, batchId: string) =>
    h.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.bundleKey, correctionBundleKey(batchId))));

  it("Split ab dem nächsten Schultag: Klassenbuch, Vertretungen und Material bleiben zugeordnet; Protokoll, Gong genau einmal, Schülersicht", async () => {
    expect(from > today).toBe(true);
    const l = await lessonOf("g-7b", 0, 5);
    const entry = { groupId: "g-7b", periodNr: 5, subjectId: l.subjectId, teacherId: l.teacherId, topic: "Gedichte" };
    await h.db.insert(classbookEntries).values([
      { ...entry, id: "k-vorher", lessonId: l.id, date: "2026-09-28" },
      { ...entry, id: "k-nachher", lessonId: l.id, date: monAfter },
    ]);
    await h.db.insert(timetableSubstitutions).values([
      { id: "s-vorher", lessonId: l.id, date: "2026-09-28", kind: "cancel" },
      { id: "s-nachher", lessonId: l.id, date: monAfter, kind: "cancel" },
    ]);
    await h.db.insert(timetableAbsenceMaterials).values([{ id: "m-nachher", lessonId: l.id, date: monAfter, text: "Buch S. 34" }]);
    const leaBefore = (await listSlots(h.db, { kind: "user", id: "u-lea.schaefer" }, monAfter, addDays(monAfter, 4))).find((x) => x.weekday === 0 && x.periodNr === 5)!;
    expect(leaBefore.roomId).toBe(l.roomId);
    const valid = (await validVersion(h.db, "sj-2026-27"))!;

    // Begründung höchstens 120 Zeichen
    expect(await errorOf(updateLesson(h.db, PLANER, l.id, inputOf(l, { roomId: "105" }), LIVE, opts(undefined, { reason: "x".repeat(121) })))).toMatch(/Höchstens 120/);
    await updateLesson(h.db, PLANER, l.id, inputOf(l, { roomId: "105" }), LIVE, opts("b-raum", { reason: "Raumtausch Brandschutz" }));

    const old = (await row(l.id))!;
    expect(old).toMatchObject({ roomId: l.roomId, validFrom: l.validFrom, validUntil: addDays(from, -1) });
    const succId = await successorOf("b-raum", l.id);
    expect(await row(succId)).toMatchObject({ roomId: "105", validFrom: from, validUntil: l.validUntil, subjectId: l.subjectId, teacherId: l.teacherId, planVersionId: valid.id, fixed: l.fixed });
    // vor dem Stichtag an der alten, danach an der neuen Stunde
    const book = new Map((await h.db.select().from(classbookEntries).where(inArray(classbookEntries.id, ["k-vorher", "k-nachher"]))).map((e) => [e.id, e.lessonId]));
    expect(book).toEqual(new Map([["k-vorher", l.id], ["k-nachher", succId]]));
    const subs = new Map((await h.db.select().from(timetableSubstitutions).where(inArray(timetableSubstitutions.id, ["s-vorher", "s-nachher"]))).map((s) => [s.id, s.lessonId]));
    expect(subs).toEqual(new Map([["s-vorher", l.id], ["s-nachher", succId]]));
    expect((await h.db.select().from(timetableAbsenceMaterials).where(eq(timetableAbsenceMaterials.id, "m-nachher")))[0]!.lessonId).toBe(succId);

    // Protokoll
    const [change] = await h.db.select().from(timetablePlanChanges).where(eq(timetablePlanChanges.batchId, "b-raum"));
    expect(change).toMatchObject({ kind: "split", lessonId: l.id, successorId: succId, validFrom: from, versionId: valid.id, reason: "Raumtausch Brandschutz", actorId: PLANER, notifiedAt: null });
    expect(change!.before).toMatchObject({ roomId: l.roomId, teacherId: l.teacherId });
    expect(change!.after).toMatchObject({ roomId: "105", validFrom: from });
    const summary = (await correctionSummary(h.db, "b-raum"))!;
    expect(summary).toMatchObject({ from, lessons: 1, kinds: { split: 1, inplace: 0, delete: 0, create: 0 }, suggestFollowUp: false });

    // Gong: Lehrkraft sofort (genau eine Nachricht), Schüler:innen zur Vortags-Uhrzeit, genau einmal
    const bra = await gongs(l.teacherId!, "b-raum");
    expect(bra).toHaveLength(1);
    expect(bra[0]!.title).toMatch(/^Stundenplan ab .+ geändert: 1 Änderung für dich$/);
    expect(bra[0]!.body).toContain(`Raum ${l.roomId} → 105`);
    expect(await gongs(PLANER, "b-raum")).toHaveLength(0);
    expect(await gongs("u-lea.schaefer", "b-raum")).toHaveLength(0);
    expect(change!.notifyAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await runPlanChangeNotifications(h.db, new Date(change!.notifyAt!.getTime() - 60_000))).toBe(0);
    expect(await runPlanChangeNotifications(h.db, change!.notifyAt!)).toBeGreaterThan(0);
    expect(await runPlanChangeNotifications(h.db, change!.notifyAt!)).toBe(0);
    const lea = await gongs("u-lea.schaefer", "b-raum");
    expect(lea).toHaveLength(1);
    expect(lea[0]!.body).toContain("Raum");
    expect(lea[0]!.body).not.toContain("Brandschutz");

    // Schülersicht: vor dem Stichtag der alte Raum, ab dann der neue
    const week = async (mon: string) => (await listSlots(h.db, { kind: "user", id: "u-lea.schaefer" }, mon, addDays(mon, 4))).find((x) => x.weekday === 0 && x.periodNr === 5)!;
    expect((await week("2026-09-28")).roomId).toBe(l.roomId);
    expect((await week(monAfter)).roomId).toBe("105");
  });

  it("anderer Tag: Vertretung ab dem Stichtag entfällt (Historie), Klassenbuch ab dann ohne Stundenbezug; Tauschen ist eine Aktion", async () => {
    // eine 7a-Stunde (nicht freitags), die freitags in der 8. Stunde nirgends kollidiert
    const candidates = await h.db
      .select()
      .from(timetableLessons)
      .where(and(eq(timetableLessons.groupId, "g-7a"), isNull(timetableLessons.couplingId)))
      .orderBy(asc(timetableLessons.weekday), asc(timetableLessons.periodNr), asc(timetableLessons.id));
    let l: TimetableLesson | undefined;
    for (const c of candidates) {
      // ein anderer Tag als Freitag: die Vertretung an diesem Tag kann nicht mitziehen
      if (c.weekday === 4 || c.validFrom > today || (c.validUntil !== null && c.validUntil < from)) continue;
      if (!(await findCollisions(h.db, inputOf(c, { weekday: 4, periodNr: 8, validFrom: from }), { excludeIds: [c.id] })).length) {
        l = c;
        break;
      }
    }
    expect(l).toBeDefined();
    await h.db.insert(timetableSubstitutions).values({ id: "s-tag", lessonId: l!.id, date: addDays(monAfter, l!.weekday), kind: "cancel" });
    await h.db.insert(classbookEntries).values({ id: "k-tag", lessonId: l!.id, date: addDays(monAfter, l!.weekday), groupId: "g-7a", periodNr: l!.periodNr, subjectId: l!.subjectId, topic: "verlegt" });
    await updateLesson(h.db, PLANER, l!.id, inputOf(l!, { weekday: 4, periodNr: 8 }), LIVE, opts("b-tag"));
    expect(await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.id, "s-tag"))).toEqual([]);
    const hist = await h.db.select().from(timetableSubstitutionChanges).where(eq(timetableSubstitutionChanges.lessonId, l!.id));
    expect(hist.map((c) => c.action)).toContain("delete");
    expect((await h.db.select().from(classbookEntries).where(eq(classbookEntries.id, "k-tag")))[0]!.lessonId).toBeNull();

    // Tauschen: beide Einheiten in einer Aktion (ein Protokoll-Bündel, ein Gong je Person)
    let m: Awaited<ReturnType<typeof movePlacement>> = null;
    let swap: [string, { state: string }] | undefined;
    for (const c of await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.groupId, "g-7b"), isNull(timetableLessons.couplingId))).orderBy(asc(timetableLessons.weekday), asc(timetableLessons.periodNr))) {
      if (c.validFrom > today || (c.validUntil !== null && c.validUntil < from)) continue;
      m = await movePlacement(h.db, c.id);
      swap = [...placementGrid(moveGridInput(m!, "g-7b", [0, 1, 2, 3, 4], [1, 2, 3, 4, 5, 6]))].find(([, cell]) => cell.state === "swap");
      if (swap) break;
    }
    expect(swap).toBeDefined();
    const [d, p] = swap![0].split("-").map(Number) as [number, number];
    expect(await moveLesson(h.db, PLANER, m!.unit[0]!.id, "g-7b", d, p, LIVE, opts("b-tausch"))).toBe("swapped");
    const rows = await h.db.select().from(timetablePlanChanges).where(eq(timetablePlanChanges.batchId, "b-tausch"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.kind === "split" && r.validFrom === from)).toBe(true);
    expect(m!.unit.every((u) => rows.some((r) => r.lessonId === u.id))).toBe(true);
  });

  it("Tausch einer heute angelegten mit einer laufenden Stunde: beide ab dem Stichtag (nie zwei Stunden im Slot)", async () => {
    const fresh = await createLesson(
      h.db,
      PLANER,
      { groupId: "g-8a", weekday: 4, periodNr: 8, subjectId: "MU", teacherId: null, roomId: null, week: "all", validFrom: "2026-08-01", validUntil: null },
      LIVE,
      opts("b-frisch"),
    );
    const m = (await movePlacement(h.db, fresh))!;
    const swap = [...placementGrid(moveGridInput(m, "g-8a", [0, 1, 2, 3, 4], [1, 2, 3, 4, 5, 6]))].find(([, c]) => c.state === "swap");
    expect(swap).toBeDefined();
    const [d, p] = swap![0].split("-").map(Number) as [number, number];
    expect(await moveLesson(h.db, PLANER, fresh, "g-8a", d, p, LIVE, opts("b-frisch-tausch"))).toBe("swapped");
    const rows = await h.db.select().from(timetablePlanChanges).where(eq(timetablePlanChanges.batchId, "b-frisch-tausch"));
    expect(rows.map((r) => r.kind).sort()).toEqual(rows.map(() => "split"));
    // heute liegt in jedem der beiden Slots genau eine Stunde der 8a
    for (const [wd, pn] of [[d, p], [4, 8]] as const) {
      const here = (await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.groupId, "g-8a"), eq(timetableLessons.weekday, wd), eq(timetableLessons.periodNr, pn)))).filter(
        (l) => l.validFrom <= today && (l.validUntil === null || l.validUntil >= today),
      );
      expect(here).toHaveLength(1);
    }
  });

  it("ohne Vergangenheitsbezug in place: heute angelegt, geändert und wieder gelöscht; laufend gelöscht endet am Vortag; Kopplung", async () => {
    const fr8 = { groupId: "g-7b", weekday: 4, periodNr: 8, subjectId: "IF", teacherId: null, roomId: null, week: "all" as const, validFrom: "2026-08-01", validUntil: null };
    const id = await createLesson(h.db, PLANER, fr8, LIVE, opts("b-neu"));
    expect((await correctionSummary(h.db, "b-neu"))!.kinds.create).toBe(1);
    await updateLesson(h.db, PLANER, id, { ...fr8, roomId: "IF1" }, LIVE, opts("b-tippfehler"));
    expect(await row(id)).toMatchObject({ roomId: "IF1", validFrom: "2026-08-01" });
    expect((await correctionSummary(h.db, "b-tippfehler"))!.kinds.inplace).toBe(1);
    await deleteLesson(h.db, PLANER, id, today, LIVE, opts("b-weg"));
    expect(await row(id)).toBeUndefined();
    expect((await h.db.select().from(timetablePlanChanges).where(eq(timetablePlanChanges.batchId, "b-weg")))[0]).toMatchObject({ kind: "delete", lessonId: null });

    const running = await lessonOf("g-7b", 3, 2);
    await deleteLesson(h.db, PLANER, running.id, today, LIVE, opts("b-ende"));
    expect(await row(running.id)).toMatchObject({ validUntil: addDays(from, -1) });

    // laufende Kopplung (Band der Q1): ein Teil ändert sich → alle Teile enden, neu gekoppelt ab dem Stichtag
    const band = await lessonOf("g-q1-bi-gk1", 0, 4);
    const parts = await h.db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, band.couplingId!)).orderBy(asc(timetableLessons.id));
    const newId = await saveCoupling(
      h.db,
      PLANER,
      band.couplingId!,
      { weekday: band.weekday, periodNr: band.periodNr, week: band.week, validFrom: band.validFrom, validUntil: band.validUntil, parts: parts.map((x) => ({ id: x.id, groupId: x.groupId, subjectId: x.subjectId, teacherId: x.teacherId, roomId: x.id === band.id ? null : x.roomId })) },
      LIVE,
      opts("b-band"),
    );
    expect(newId).not.toBe(band.couplingId);
    const fresh = await h.db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, newId));
    expect(fresh).toHaveLength(parts.length);
    expect(fresh.every((x) => x.validFrom === from)).toBe(true);
    expect((await h.db.select().from(timetableLessons).where(inArray(timetableLessons.id, parts.map((x) => x.id)))).every((x) => x.validUntil === addDays(from, -1))).toBe(true);
    await deleteCoupling(h.db, PLANER, newId, LIVE, opts("b-band-weg"));
    // erst ab dem Stichtag gültig → ohne Vergangenheitsbezug ganz gelöscht
    expect(await h.db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, newId))).toEqual([]);
  });

  it(`ab ${FOLLOW_UP_HINT} geänderten Stunden: Hinweis „besser als Folgeversion“`, async () => {
    const lessons = await h.db.select().from(timetableLessons).where(eq(timetableLessons.groupId, "g-9a")).orderBy(asc(timetableLessons.id));
    const single = lessons.filter((x) => !x.couplingId && x.teacherId && x.validFrom <= today && (x.validUntil === null || x.validUntil >= from));
    let n = 0;
    let last = null as Awaited<ReturnType<typeof correctionSummary>>;
    for (const x of single) {
      last = await (async () => {
        await updateLesson(h.db, PLANER, x.id, inputOf(x, { teacherId: null }), LIVE, opts(`b-9a-${n}`));
        return correctionSummary(h.db, `b-9a-${n++}`);
      })();
      if (last!.versionTotal >= FOLLOW_UP_HINT) break;
      expect(last!.suggestFollowUp).toBe(false);
    }
    expect(last!.versionTotal).toBeGreaterThanOrEqual(FOLLOW_UP_HINT);
    expect(last!.suggestFollowUp).toBe(true);
  });

  it("R3: offene Entwürfe ziehen nach – Herkunft folgt, unverändert übernommene Stunden den Inhalt; Veröffentlichen dreht nichts zurück", async () => {
    const viewer: Viewer = { userId: PLANER, manage: true, review: true };
    const v = await createDraft(h.db, PLANER, { schoolYearId: "sj-2026-27", source: "live_copy", validFrom: "2027-02-01", numbering: "major", name: "2. Halbjahr" }, today);
    const a = await lessonOf("g-6a", 0, 1);
    const b = await lessonOf("g-6a", 0, 2);
    const draftOf = async (origin: string) => (await h.db.select().from(timetableDraftLessons).where(and(eq(timetableDraftLessons.versionId, v.id), eq(timetableDraftLessons.originLessonId, origin))))[0];
    // die Planung hat B im Entwurf schon anders geplant (ohne Raum)
    await h.db.update(timetableDraftLessons).set({ roomId: null }).where(eq(timetableDraftLessons.id, (await draftOf(b.id))!.id));

    // echte Uhrzeit: „seit der Entwurf angelegt wurde“ vergleicht mit seiner Anlagezeit
    const real = (batchId: string) => ({ today, now: new Date(), batchId });
    await updateLesson(h.db, PLANER, a.id, inputOf(a, { teacherId: null }), LIVE, real("b-r3-a"));
    await updateLesson(h.db, PLANER, b.id, inputOf(b, { teacherId: null }), LIVE, real("b-r3-b"));
    const sa = await successorOf("b-r3-a", a.id);
    const sb = await successorOf("b-r3-b", b.id);
    expect(await draftOf(a.id)).toBeUndefined();
    expect(await draftOf(sa)).toMatchObject({ teacherId: null, roomId: a.roomId });
    // B: Herkunft folgt, der Entwurf behält seine Planung (Lehrkraft bleibt, kein Raum)
    expect(await draftOf(sb)).toMatchObject({ teacherId: b.teacherId, roomId: null });
    // neue Stunde im gültigen Plan kommt in den Entwurf
    const fr8 = { groupId: "g-6a", weekday: 4, periodNr: 8, subjectId: "MU", teacherId: null, roomId: null, week: "all" as const, validFrom: "2026-08-01", validUntil: null };
    const n = await createLesson(h.db, PLANER, fr8, LIVE, real("b-r3-neu"));
    expect(await draftOf(n)).toMatchObject({ validFrom: "2027-02-01", subjectId: "MU" });

    // der Diff erkennt die Paare: A und die neue Stunde unverändert, B geändert
    const diff = await loadPlanDiff(h.db, v.id, null, today);
    if (!diff.ok) throw new Error(diff.problem);
    const entry = (id: string) => diff.diff.entries.find((e) => e.before?.id === id);
    expect(entry(sa)?.kind).toBe("unchanged");
    expect(entry(n)?.kind).toBe("unchanged");
    expect(entry(sb)).toMatchObject({ kind: "changed", changes: expect.arrayContaining(["teacher", "room"]) });
    expect(diff.diff.counts.added).toBe(0);
    expect((await correctionsSince(h.db, "sj-2026-27", v.createdAt)).actions).toBe(3);

    // Veröffentlichen: die korrigierte Stunde A bleibt, wie sie ist (gleiche Zeile, keine Lehrkraft)
    await submitForReview(h.db, viewer, v.id, now);
    await approveVersion(h.db, viewer, v.id, now);
    await publishVersion(h.db, PLANER, v.id, "2027-02-01", today, now);
    expect(await row(sa)).toMatchObject({ teacherId: null, validFrom: from, validUntil: a.validUntil });
    // die neu angelegte Stunde war im Entwurf unverändert → bleibt
    expect(await row(n)).toMatchObject({ subjectId: "MU", validUntil: null });
  });

  it("Kontolöschung ersetzt die Lehrkraft in Vorher/Nachher des Protokolls", async () => {
    const before = await h.db.select().from(timetablePlanChanges);
    expect(JSON.stringify(before.map((r) => [r.before, r.after]))).toContain("u-jana.brandt");
    await deleteAccounts(h.db, ["u-jana.brandt"]);
    const after = await h.db.select().from(timetablePlanChanges);
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after.map((r) => [r.before, r.after]))).not.toContain("u-jana.brandt");
  });
});
