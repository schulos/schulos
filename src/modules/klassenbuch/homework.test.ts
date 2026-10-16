import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { classbookEntries, parentChild, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions } from "@/core/permissions";
import { listUsers } from "@/modules/verwaltung/users";
import { homeworkOwners, recentHomeworkOfGroup, upcoming, upcomingHomeworkFor, withDueDates, type HomeworkItem } from "./homework";
import { PARENTS_HOMEWORK } from "./settings";

const entry = (over: Partial<HomeworkItem> & { homeworkDue?: string | null }): Omit<HomeworkItem, "due" | "dueSet"> & { homeworkDue: string | null } => ({
  entryId: "e1",
  givenOn: "2026-10-05",
  groupId: "g-7b",
  groupName: "Klasse 7b",
  subjectId: "D",
  subjectName: "Deutsch",
  color: "#c00",
  homework: "Gliederung",
  homeworkDue: null,
  ...over,
});
const item = (over: Partial<HomeworkItem>, due: string | null): HomeworkItem => ({ ...withDueDates([entry(over)], [])[0]!, due });

describe("Hausaufgaben (Q5-02): rein", () => {
  it("fällig zur nächsten Stunde derselben Gruppe im selben Fach, Entfall übersprungen", () => {
    const slots = [
      { date: "2026-10-05", groupId: "g-7b", subjectId: "D" },
      { date: "2026-10-06", groupId: "g-7b", subjectId: "M" },
      { date: "2026-10-07", groupId: "g-7a", subjectId: "D" },
      { date: "2026-10-07", groupId: "g-7b", subjectId: "D", change: { kind: "cancel" as const, substituteId: null, substituteName: null, substituteCode: null, roomId: null, note: null } },
      { date: "2026-10-12", groupId: "g-7b", subjectId: "D" },
    ];
    expect(withDueDates([entry({})], slots)[0]!.due).toBe("2026-10-12");
    expect(withDueDates([entry({ subjectId: "E" })], slots)[0]!.due).toBeNull();
  });

  it("„fällig am“ (Q5-27) geht vor der nächsten Stunde – auch ohne Stunde im Plan", () => {
    const slots = [{ date: "2026-10-07", groupId: "g-7b", subjectId: "D" }];
    expect(withDueDates([entry({ homeworkDue: "2026-10-09" })], slots)[0]).toMatchObject({ due: "2026-10-09", dueSet: true });
    expect(withDueDates([entry({ subjectId: "E", homeworkDue: "2026-10-09" })], slots)[0]).toMatchObject({ due: "2026-10-09", dueSet: true });
    expect(withDueDates([entry({})], slots)[0]).toMatchObject({ due: "2026-10-07", dueSet: false });
  });

  it("Widget: ab heute bis zum dritten Schultag, sortiert nach Fälligkeit und Fach", () => {
    const items: HomeworkItem[] = [
      item({ entryId: "a", subjectName: "Mathe" }, "2026-10-08"),
      item({ entryId: "b", subjectName: "Deutsch" }, "2026-10-08"),
      item({ entryId: "c" }, "2026-10-06"),
      item({ entryId: "d" }, "2026-10-12"), // vierter Schultag
      item({ entryId: "e" }, "2026-10-02"), // vorbei
      item({ entryId: "f" }, null),
    ];
    const days = ["2026-10-05", "2026-10-06", "2026-10-08", "2026-10-12"].map((date) => ({ date }));
    expect(upcoming(items, days, "2026-10-05").map((i) => i.entryId)).toEqual(["c", "b", "a"]);
    expect(upcoming(items, [], "2026-10-05")).toEqual([]);
  });
});

describe("Hausaufgaben (Q5-02): Schüler:innen, Eltern, Kursraum", () => {
  let h: DbHandle;
  let parentId: string;
  const MO = "2026-10-05";
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(classbookEntries);
    await h.db.delete(timetableLessons);
    const base = { validFrom: "2026-08-01", validUntil: null, groupId: "g-7b", roomId: "106" };
    const [d1, m1, , m2] = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, weekday: 0, periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt" },
        { ...base, weekday: 0, periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine" },
        { ...base, weekday: 2, periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt" },
        { ...base, weekday: 3, periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine" },
      ])
      .returning({ id: timetableLessons.id });
    const e = { groupId: "g-7b", date: MO };
    await h.db.insert(classbookEntries).values([
      { ...e, lessonId: d1!.id, periodNr: 1, subjectId: "D", topic: "Erörterung", homework: "Gliederung fertigstellen", teacherId: "u-jana.brandt" },
      { ...e, lessonId: m1!.id, periodNr: 2, subjectId: "M", topic: "Brüche", homework: "S. 12 Nr. 3", teacherId: "u-tobias.kleine" },
      // ohne Hausaufgabe: erscheint nirgends
      { ...e, date: "2026-09-28", lessonId: m1!.id, periodNr: 2, subjectId: "M", topic: "Wiederholung", homework: null, teacherId: "u-tobias.kleine" },
    ]);
    // Mathe am Donnerstag entfällt → fällig erst am Montag darauf
    await h.db.insert(timetableSubstitutions).values({ lessonId: m2!.id, date: "2026-10-08", kind: "cancel" });
    [{ parentId }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"))) as [{ parentId: string }];
  }, 60_000);
  afterAll(() => h.close());

  it("Schülerin sieht die Hausaufgaben der nächsten Schultage mit Fälligkeit", async () => {
    const items = await upcomingHomeworkFor(h.db, "u-lea.schaefer", MO);
    expect(items.map((i) => [i.subjectName, i.homework, i.due])).toEqual([["Deutsch", "Gliederung fertigstellen", "2026-10-07"]]);
    // am Mittwoch: Mathe (Do entfällt → fällig Mo 12.10.) liegt im dritten Schultag (Mi, Do, Mo)
    const wed = await upcomingHomeworkFor(h.db, "u-lea.schaefer", "2026-10-07");
    expect(wed.map((i) => [i.subjectId, i.due])).toEqual([
      ["D", "2026-10-07"],
      ["M", "2026-10-12"],
    ]);
    expect(await homeworkOwners(h.db, await p("u-lea.schaefer"))).toEqual([expect.objectContaining({ id: "u-lea.schaefer" })]);
  });

  it("Eltern: Vorgabe aus; „bis Jahrgang 7“ zeigt das Kind der 7b, „bis 6“ nicht; Lehrkräfte nie", async () => {
    expect(await homeworkOwners(h.db, await p(parentId))).toEqual([]);
    await writeModuleSetting(h.db, PARENTS_HOMEWORK, "7");
    expect((await homeworkOwners(h.db, await p(parentId))).map((o) => o.id)).toContain("u-lea.schaefer");
    await writeModuleSetting(h.db, PARENTS_HOMEWORK, "6");
    expect((await homeworkOwners(h.db, await p(parentId))).map((o) => o.id)).not.toContain("u-lea.schaefer");
    expect(await homeworkOwners(h.db, await p("u-jana.brandt"))).toEqual([]);
  });

  it("Eltern von Oberstufen-Schüler:innen nie – auch nicht bei „bis Jahrgang 10“", async () => {
    await writeModuleSetting(h.db, PARENTS_HOMEWORK, "10");
    const [q1] = (await listUsers(h.db, { groupId: "g-q1", role: "schueler" })).rows;
    const [parent] = await h.db.select({ id: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, q1!.id));
    const owners = (await homeworkOwners(h.db, await p(parent!.id))).map((o) => o.id);
    expect(owners).not.toContain(q1!.id);
    // Gegenprobe: dasselbe Elternteil mit einem Kind in der 7b
    await h.db.insert(parentChild).values({ parentId: parent!.id, childId: "u-lea.schaefer" }).onConflictDoNothing();
    expect((await homeworkOwners(h.db, await p(parent!.id))).map((o) => o.id)).toContain("u-lea.schaefer");
    await writeModuleSetting(h.db, PARENTS_HOMEWORK, "0");
  });

  it("„fällig am“ (Q5-27): Widget, Kursraum und Eltern nutzen das gesetzte Datum; lange Fristen bleiben sichtbar", async () => {
    const [d] = await h.db.select({ id: classbookEntries.id }).from(classbookEntries).where(eq(classbookEntries.subjectId, "D"));
    // Deutsch vom 5.10. erst am Freitag 9.10. fällig (statt Mittwoch 7.10.)
    await h.db.update(classbookEntries).set({ homeworkDue: "2026-10-09" }).where(eq(classbookEntries.id, d!.id));
    expect(await upcomingHomeworkFor(h.db, "u-lea.schaefer", MO)).toEqual([]); // Mo: Mo, Mi, Do – Freitag liegt dahinter
    const items = await upcomingHomeworkFor(h.db, "u-lea.schaefer", "2026-10-07");
    expect(items.map((i) => [i.subjectId, i.due, i.dueSet])).toEqual([
      ["D", "2026-10-09", true],
      ["M", "2026-10-12", false],
    ]);
    const group = await recentHomeworkOfGroup(h.db, "g-7b", "2026-10-06");
    expect(group.find((i) => i.subjectId === "D")).toMatchObject({ due: "2026-10-09", dueSet: true });
    // Eltern: dieselbe Liste über das Kind (Moduleinstellung an)
    await writeModuleSetting(h.db, PARENTS_HOMEWORK, "7");
    const owners = await homeworkOwners(h.db, await p(parentId));
    expect(owners.map((o) => o.id)).toContain("u-lea.schaefer");
    await writeModuleSetting(h.db, PARENTS_HOMEWORK, "0");
    // Frist weiter als der Rückblick (21 Tage): am Fälligkeitstag noch im Widget
    await h.db.update(classbookEntries).set({ homeworkDue: "2026-11-02" }).where(eq(classbookEntries.id, d!.id));
    const later = await upcomingHomeworkFor(h.db, "u-lea.schaefer", "2026-11-02");
    expect(later.map((i) => [i.subjectId, i.due])).toEqual([["D", "2026-11-02"]]);
    await h.db.update(classbookEntries).set({ homeworkDue: null }).where(eq(classbookEntries.id, d!.id));
  });

  it("Kursraum: zuletzt aufgegebene Hausaufgaben der Gruppe, neueste zuerst", async () => {
    const items = await recentHomeworkOfGroup(h.db, "g-7b", "2026-10-06");
    expect(items.map((i) => [i.homework, i.due])).toEqual([
      ["S. 12 Nr. 3", "2026-10-12"],
      ["Gliederung fertigstellen", "2026-10-07"],
    ]);
    expect(await recentHomeworkOfGroup(h.db, "g-7a", "2026-10-06")).toEqual([]);
  });
});
