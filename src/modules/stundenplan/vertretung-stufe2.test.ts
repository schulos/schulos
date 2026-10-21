// SP2-07 (SP-G-08): Vertretung Stufe 2 – Verlegung (auch Tausch, Band-Stunden), Zusammenlegung/Mitbetreuung, Bereitschaft;
// Konflikte (Gruppe, Lehrkraft, Raum doppelt, Tagesregeln SP2-04) und Anzeige in Plan, Vertretungsplan, Raum und Gong.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, timetableLessons, timetableStandby, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { groupPeriod, ownTeacherPeriod, roomUse } from "./belegung";
import { addStandby, listStandby, removeStandby, standbyAt } from "./bereitschaft";
import { saveTeacherRule } from "./deputate";
import { changeLabel, changeRoom, changeTeacher, slotDisplay } from "./display";
import { occupancyOn } from "./raeume";
import { listSlots } from "./service";
import { planningYear } from "./verteilung";
import { deleteSubstitution, mergeOptions, roomLessonAt, saveSubstitution, substitutionsOn } from "./vertretung";
import { dayMessage, type DayChange } from "./vertretung-gong";
import { suggestSubstitutes } from "./vorschlaege";

const MO = "2026-10-05";
const DI = "2026-10-06";
const BRA = "u-jana.brandt";
const KLE = "u-tobias.kleine";
const WAG = "u-sophie.wagner";
const RIC = "u-jonas.richter";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("SP2-07 rein", () => {
  const l = { periodNr: 3, roomId: "106" };
  const sub = (kind: "cancel" | "substitute" | "room" | "move" | "merge", extra: Partial<{ roomId: string; targetPeriod: number }> = {}) => ({
    kind,
    substituteId: null,
    roomId: extra.roomId ?? null,
    targetPeriod: extra.targetPeriod ?? null,
  });
  it("Belegung: Verlegung zählt in der neuen Stunde, Zusammenlegung gibt Lehrkraft und Raum frei, nicht die Gruppe", () => {
    expect(ownTeacherPeriod(l, undefined)).toBe(3);
    expect(ownTeacherPeriod(l, sub("move", { targetPeriod: 1 }))).toBe(1);
    expect(ownTeacherPeriod(l, sub("merge"))).toBeNull();
    expect(groupPeriod(l, sub("merge"))).toBe(3);
    expect(groupPeriod(l, sub("cancel"))).toBeNull();
    expect(roomUse(l, sub("move", { targetPeriod: 1 }))).toEqual({ periodNr: 1, roomId: "106" });
    expect(roomUse(l, sub("move", { targetPeriod: 1, roomId: "201" }))).toEqual({ periodNr: 1, roomId: "201" });
    expect(roomUse(l, sub("merge"))).toBeNull();
  });

  it("Gong-Text: Verlegung nennt die neue Stunde, Zusammenlegung Gruppe und Lehrkraft", () => {
    const base: DayChange = { lessonId: "l", groupId: "g", groupName: "Klasse 7b", periodNr: 5, subjectName: "Deutsch", kind: "move", targetPeriod: 1, teacherId: "t", substituteId: null, substituteName: null, roomId: null, note: null };
    expect(dayMessage(MO, [base])).toEqual({ title: "Verlegung Mo., 5.10., 5. Std: Deutsch (7b)", body: "in der 1. Std" });
    expect(dayMessage(MO, [{ ...base, kind: "merge", targetPeriod: null, mergeGroup: "Klasse 7a", substituteName: "Jana Brandt", roomId: "105" }])).toEqual({
      title: "Zusammenlegung Mo., 5.10., 5. Std: Deutsch (7b)",
      body: "mit 7a · bei Jana Brandt · Raum 105",
    });
  });

  it("Anzeige: Art, Lehrkraft und Raum je Eintrag", () => {
    const e = { kind: "move" as const, movedFrom: 5, movedTo: null, mergeWith: null, substituteCode: null, roomId: "106", newRoomId: null };
    expect(changeLabel(e)).toBe("Verlegung aus der 5. Std.");
    expect(changeLabel({ ...e, movedFrom: null, movedTo: 1 })).toBe("verlegt in die 1. Std.");
    expect(changeRoom({ ...e, movedFrom: null, movedTo: 1 })).toBeNull();
    const m = { ...e, kind: "merge" as const, movedFrom: null, mergeWith: { groupName: "Klasse 7a", teacherCode: "BRA", roomId: "105" } };
    expect(changeLabel(m)).toBe("Zusammenlegung mit 7a");
    expect(changeTeacher(m)).toBe("BRA");
    expect(changeRoom(m)).toBe("105");
  });
});

describe("SP2-07 Vertretung Stufe 2", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  const mo = { weekday: 0, validFrom: "2026-08-01", validUntil: null };

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  beforeEach(async () => {
    await h.db.delete(timetableSubstitutions);
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableStandby);
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        // 7b am Montag: 1. Sport (KLE), 3. Mathe (RIC), 5. Deutsch (BRA)
        { ...mo, groupId: "g-7b", periodNr: 1, subjectId: "SP", teacherId: KLE, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 3, subjectId: "M", teacherId: RIC, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 5, subjectId: "D", teacherId: BRA, roomId: "106" },
        // 7a: 1. Mathe (WAG, Raum 105), 4. Englisch (KLE) – 7b hat in der 4. Bio bei BRA
        { ...mo, groupId: "g-7a", periodNr: 1, subjectId: "M", teacherId: WAG, roomId: "105" },
        { ...mo, groupId: "g-7a", periodNr: 4, subjectId: "E", teacherId: KLE, roomId: "105" },
        { ...mo, groupId: "g-7b", periodNr: 4, subjectId: "BI", teacherId: BRA, roomId: "106" },
        // Band-Stunde (eine coupling_id je Band-Stunde, SP2-02): 9a Religion (RIC) + 9b Philosophie (WAG) in der 6.
        { ...mo, groupId: "g-9a", periodNr: 6, subjectId: "M", teacherId: RIC, roomId: "201", couplingId: "band-6" },
        { ...mo, groupId: "g-9b", periodNr: 6, subjectId: "D", teacherId: WAG, roomId: "202", couplingId: "band-6" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.groupId.slice(2)}-${r.periodNr}`] = r.id;
  });

  const save = (lessonId: string, kind: "cancel" | "substitute" | "room" | "move" | "merge", extra: Partial<Parameters<typeof saveSubstitution>[2]> = {}) =>
    saveSubstitution(h.db, "u-admin", { lessonId, date: MO, kind, substituteId: null, roomId: null, note: null, ...extra });

  it("Verlegung: Deutsch rückt auf die ausgefallene 1. Stunde – Plan, Vertretungsplan und Raum zeigen beide Stunden", async () => {
    await save(ids["7b-1"]!, "cancel");
    await save(ids["7b-5"]!, "move", { targetPeriod: 1 });
    const slots = await listSlots(h.db, { kind: "group", id: "g-7b" }, MO, DI);
    const deutsch = slots.filter((s) => s.lessonId === ids["7b-5"]);
    expect(deutsch.map((s) => [s.periodNr, s.moved])).toEqual([
      [1, "to"],
      [5, "from"],
    ]);
    expect(slotDisplay(deutsch[0]!, "group")).toMatchObject({ tag: "Verlegt hierher", struck: false });
    expect(slotDisplay(deutsch[1]!, "group")).toMatchObject({ tag: "Verlegt", struck: true });
    // Lehrkraft BRA: Deutsch in der 1., in der 5. frei
    const bra = await listSlots(h.db, { kind: "teacher", id: BRA }, MO, DI);
    expect(bra.filter((s) => s.lessonId === ids["7b-5"] && s.perspective !== "away").map((s) => s.periodNr)).toEqual([1]);
    const plan = (await substitutionsOn(h.db, [MO])).filter((e) => e.lessonId === ids["7b-5"]);
    expect(plan.map((e) => [e.periodNr, changeLabel(e)])).toEqual([
      [1, "Verlegung aus der 5. Std."],
      [5, "verlegt in die 1. Std."],
    ]);
    expect(await roomLessonAt(h.db, "106", MO, 1)).toMatchObject({ subjectName: "Deutsch" });
    expect(await roomLessonAt(h.db, "106", MO, 5)).toBeNull();
    const occ = (await occupancyOn(h.db, MO)).occupancy;
    expect(occ.get("106")?.get(1)).toMatchObject({ kind: "lesson", moved: true });
    expect(occ.get("106")?.get(5)).toBeUndefined();
    // die 1. Stunde ist jetzt belegt: Sport kann dort nicht wieder stattfinden, der Entfall nicht aufgehoben werden
    expect((await fieldErrors(save(ids["7b-1"]!, "substitute", { substituteId: WAG }))).kind).toMatch(/verlegt/);
    const cancel = (await substitutionsOn(h.db, [MO])).find((e) => e.lessonId === ids["7b-1"])!;
    expect((await fieldErrors(deleteSubstitution(h.db, "u-admin", cancel.id))).kind).toMatch(/erst die Verlegung aufheben/);
    // Gong: die Schülerin der 7b erfährt die Verlegung
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-lea.schaefer"), eq(notifications.moduleId, "stundenplan")));
    expect(gong.at(-1)?.body).toContain("in der 1. Std");
  });

  it("Verlegung – Konflikte: Gruppe, Lehrkraft und Raum in der Zielstunde, eigene Stunde, fehlende Stunde", async () => {
    // die 7b hat in der 3. Stunde Mathe
    expect((await fieldErrors(save(ids["7b-5"]!, "move", { targetPeriod: 3 }))).targetPeriod).toMatch(/hat in der 3\. Stunde Unterricht/);
    // BRA unterrichtet in der 4. Stunde → nach Entfall der 7b-Bio wäre die Gruppe frei, aber BRA ... (eigene Stunde der 7b) – nimm 7a-1: WAG in der 6. belegt
    await save(ids["7a-4"]!, "cancel");
    expect((await fieldErrors(save(ids["7a-1"]!, "move", { targetPeriod: 6 }))).targetPeriod).toMatch(/WAG|Sophie|nicht frei/);
    // Raum: 7a-1 in die 2. Stunde mit Raum 106 – frei; mit Raum 201 in der 6. belegt (Band)
    await save(ids["7a-1"]!, "move", { targetPeriod: 2, roomId: "106" });
    expect((await fieldErrors(save(ids["7b-5"]!, "move", { targetPeriod: 2 }))).targetPeriod).toMatch(/Raum 106 ist in der 2\. Stunde belegt|7b/);
    expect((await fieldErrors(save(ids["7b-5"]!, "move", { targetPeriod: 5 }))).targetPeriod).toBe("Das ist die eigene Stunde");
    expect((await fieldErrors(save(ids["7b-5"]!, "move", { targetPeriod: 99 }))).targetPeriod).toBe("Stunde wählen, in die verlegt wird");
  });

  it("Tausch: Deutsch (5.) und Mathe (3.) tauschen; Aufheben nimmt beide zurück", async () => {
    await save(ids["7b-5"]!, "move", { targetPeriod: 3, swap: true });
    const plan = await substitutionsOn(h.db, [MO]);
    expect(plan.filter((e) => e.movedFrom !== null).map((e) => [e.periodNr, e.subjectName]).sort()).toEqual([
      [3, "Deutsch"],
      [5, "Mathematik"],
    ]);
    const row = plan.find((e) => e.lessonId === ids["7b-5"])!;
    await deleteSubstitution(h.db, "u-admin", row.id);
    expect(await substitutionsOn(h.db, [MO])).toEqual([]);
    // Tausch ohne Unterricht in der Zielstunde geht nicht
    expect((await fieldErrors(save(ids["7b-5"]!, "move", { targetPeriod: 2, swap: true }))).targetPeriod).toMatch(/keinen Unterricht zum Tauschen/);
  });

  it("Band-Stunde: die Verlegung bewegt alle Teile – und braucht alle Lehrkräfte frei", async () => {
    await save(ids["9a-6"]!, "move", { targetPeriod: 2 });
    const rows = await h.db.select().from(timetableSubstitutions);
    expect(rows.map((r) => [r.lessonId, r.kind, r.targetPeriod]).sort()).toEqual(
      [
        [ids["9a-6"], "move", 2],
        [ids["9b-6"], "move", 2],
      ].sort(),
    );
    await deleteSubstitution(h.db, "u-admin", rows[0]!.id);
    expect(await h.db.select().from(timetableSubstitutions)).toEqual([]);
    // WAG (Teil 9b) unterrichtet in der 1. Stunde die 7a → nicht frei
    expect((await fieldErrors(save(ids["9a-6"]!, "move", { targetPeriod: 1 }))).targetPeriod).toMatch(/nicht frei/);
  });

  it("Zusammenlegung: 7a geht in der 4. Stunde zur 7b (BRA betreut mit) – Anzeige, Gong an BRA, Schutz der aufnehmenden Stunde", async () => {
    const options = await mergeOptions(h.db, ids["7a-4"]!, MO);
    expect(options.map((o) => o.lessonId)).toEqual([ids["7b-4"]]);
    expect(options[0]!.label).toContain("BRA");
    await save(ids["7a-4"]!, "merge", { mergeLessonId: ids["7b-4"] });
    const e = (await substitutionsOn(h.db, [MO])).find((x) => x.lessonId === ids["7a-4"])!;
    expect(e.mergeWith).toEqual({ groupName: "Klasse 7b", teacherCode: "BRA", roomId: "106" });
    expect([changeTeacher(e), changeRoom(e)]).toEqual(["BRA", "106"]);
    // BRA sieht die 7a bei sich, KLE die Stunde als abgegeben; Raum 105 ist frei
    const bra = await listSlots(h.db, { kind: "teacher", id: BRA }, MO, DI);
    expect(bra.find((s) => s.lessonId === ids["7b-4"])!.joined).toEqual(["Klasse 7a"]);
    expect(slotDisplay(bra.find((s) => s.lessonId === ids["7b-4"])!, "teacher").tag).toBe("Mitbetreuung");
    const kle = await listSlots(h.db, { kind: "teacher", id: KLE }, MO, DI);
    expect(kle.find((s) => s.lessonId === ids["7a-4"])!.perspective).toBe("away");
    expect(await roomLessonAt(h.db, "105", MO, 4)).toBeNull();
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, BRA), eq(notifications.moduleId, "stundenplan")));
    expect(gong.at(-1)?.title).toContain("Zusammenlegung");
    // KLE ist frei (Vorschläge/Vertretung) – die aufnehmende Stunde kann nicht entfallen, solange die 7a dort ist
    expect((await fieldErrors(save(ids["7b-4"]!, "cancel"))).kind).toMatch(/Klasse 7a ist zu dieser Stunde zusammengelegt/);
    // Konflikte: dieselbe Gruppe, andere Zeit, keine Stunde
    expect((await fieldErrors(save(ids["7b-5"]!, "merge", { mergeLessonId: ids["7b-4"] }))).mergeLessonId).toBe("Stunde zur selben Zeit wählen");
    expect((await fieldErrors(save(ids["7b-3"]!, "merge", { mergeLessonId: null }))).mergeLessonId).toBe("Stunde zur selben Zeit wählen");
  });

  it("Bereitschaft: Pflege, Prüfungen, oben in den Vorschlägen", async () => {
    const year = (await planningYear(h.db))!;
    // WAG unterrichtet in der 1. → keine Bereitschaft; in der 3. frei
    expect((await fieldErrors(addStandby(h.db, "u-admin", { schoolYearId: year.id, teacherId: WAG, weekday: 0, periodNr: 1 }))).teacherId).toMatch(/unterrichtet/);
    expect((await fieldErrors(addStandby(h.db, "u-admin", { schoolYearId: year.id, teacherId: "u-lea.schaefer", weekday: 0, periodNr: 3 }))).teacherId).toBe("Lehrkraft wählen");
    const id = await addStandby(h.db, "u-admin", { schoolYearId: year.id, teacherId: WAG, weekday: 0, periodNr: 3 });
    expect((await fieldErrors(addStandby(h.db, "u-admin", { schoolYearId: year.id, teacherId: WAG, weekday: 0, periodNr: 3 }))).teacherId).toMatch(/schon eingetragen/);
    expect((await listStandby(h.db, year.id)).map((e) => [e.teacherId, e.weekday, e.periodNr])).toEqual([[WAG, 0, 3]]);
    expect([...(await standbyAt(h.db, MO, 3))]).toEqual([WAG]);
    const s = await suggestSubstitutes(h.db, ids["7b-3"]!, MO);
    expect(s[0]).toMatchObject({ id: WAG, standby: true });
    expect(s[0]!.reasons.map((r) => r.label)).toContain("Bereitschaft");
    await removeStandby(h.db, "u-admin", id);
    expect(await listStandby(h.db, year.id)).toEqual([]);
  });

  it("Tagesregel (SP2-04): wer mit der Vertretung über „höchstens n Stunden am Tag“ käme, wird weder vorgeschlagen noch gespeichert", async () => {
    const year = (await planningYear(h.db))!;
    // BRA hält montags 4. und 5. Stunde → höchstens 2
    await saveTeacherRule(h.db, "u-admin", year.id, BRA, { maxPerDay: 2, maxDays: null });
    expect((await suggestSubstitutes(h.db, ids["7b-3"]!, MO)).map((c) => c.id)).not.toContain(BRA);
    expect((await fieldErrors(save(ids["7b-3"]!, "substitute", { substituteId: BRA }))).substituteId).toMatch(/Tagesregel: höchstens 2 Stunden am Tag/);
    // nach Verlegung der 5. auf … bleibt es bei 2 Stunden am Tag; ohne Regel geht es
    await saveTeacherRule(h.db, "u-admin", year.id, BRA, { maxPerDay: null, maxDays: null });
    await save(ids["7b-3"]!, "substitute", { substituteId: BRA });
  });
});
