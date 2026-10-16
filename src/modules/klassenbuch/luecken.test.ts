import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { classbookEntries, notifications, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { OPEN_CALENDAR, SchoolCalendar } from "@/core/school/calendar";
import { fromBerlinLocal } from "@/core/time";
import { setModuleEnabled } from "@/core/modules/registry";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import manifest from "./manifest";
import { GAP_BUNDLE_KEY, gapWindowStart, openLessons, pickOpen, runGapReminders } from "./luecken";
import type { MySlot } from "./service";

const slot = (over: Partial<MySlot>): MySlot =>
  ({ lessonId: "l1", date: "2026-10-05", periodNr: 1, startsAt: "08:00", endsAt: "08:45", groupName: "7b", hasEntry: false, ...over }) as MySlot;

describe("Klassenbuch-Lücken (Q5-06): rein", () => {
  it("Fenster: zehn Schultage rückwärts, Wochenenden und Ferien zählen nicht", () => {
    // Fr 9.10.: Fr…Mo dieser Woche (5) + Fr…Mo der Vorwoche (5) → Mo 28.9.
    expect(gapWindowStart(OPEN_CALENDAR, "2026-10-09")).toBe("2026-09-28");
    // am Samstag zählt der Tag selbst nicht
    expect(gapWindowStart(OPEN_CALENDAR, "2026-10-10")).toBe("2026-09-28");
    const withBreak = new SchoolCalendar("NW", [{ id: "x", kind: "ferien", name: "Herbstferien", startsOn: "2026-10-12", endsOn: "2026-10-23" }]);
    // Mo 26.10. nach den Ferien: Mo 26.10. + 9 Schultage vor den Ferien (Fr 9.10. … Mo 28.9. ohne Mo 28.9.)
    expect(gapWindowStart(withBreak, "2026-10-26", 10)).toBe("2026-09-29");
  });

  it("offen: ohne Eintrag und vorbei (heute erst nach Stundenende), neueste zuerst", () => {
    const slots = [
      slot({ lessonId: "a", date: "2026-10-05" }),
      slot({ lessonId: "b", date: "2026-10-05", hasEntry: true }),
      slot({ lessonId: "c", date: "2026-10-07", periodNr: 1, endsAt: "08:45" }),
      slot({ lessonId: "d", date: "2026-10-07", periodNr: 3, endsAt: "10:30" }),
    ];
    expect(pickOpen(slots, "2026-10-07", "09:00").map((s) => s.lessonId)).toEqual(["c", "a"]);
    expect(pickOpen(slots, "2026-10-07", "10:30").map((s) => s.lessonId)).toEqual(["c", "d", "a"]);
  });
});

describe("Klassenbuch-Lücken (Q5-06): eigene Stunden, Freitags-Gong", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  // Fr 9.10.2026, 16 Uhr (Berlin)
  const FRIDAY = fromBerlinLocal("2026-10-09T16:00");

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(classbookEntries);
    await h.db.delete(timetableLessons);
    await h.db.delete(notifications);
    const base = { validFrom: "2026-08-01", validUntil: null, groupId: "g-7b", roomId: "106" };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, weekday: 0, periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt" },
        { ...base, weekday: 4, periodNr: 2, subjectId: "E", teacherId: "u-jana.brandt" },
        { ...base, weekday: 2, periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine" },
      ])
      .returning({ id: timetableLessons.id, subjectId: timetableLessons.subjectId });
    for (const r of rows) ids[r.subjectId] = r.id;
    // Deutsch am 5.10. eingetragen, am 28.9. nicht; Englisch am 2.10. entfallen
    await h.db.insert(classbookEntries).values({ lessonId: ids.D!, date: "2026-10-05", groupId: "g-7b", periodNr: 1, subjectId: "D", topic: "x", teacherId: "u-jana.brandt" });
    await h.db.insert(timetableSubstitutions).values({ lessonId: ids.E!, date: "2026-10-02", kind: "cancel" });
    // Mathe: alles eingetragen
    for (const date of ["2026-09-30", "2026-10-07"]) {
      await h.db.insert(classbookEntries).values({ lessonId: ids.M!, date, groupId: "g-7b", periodNr: 2, subjectId: "M", topic: "x", teacherId: "u-tobias.kleine" });
    }
  }, 60_000);
  afterAll(() => h.close());

  it("nur eigene Stunden der letzten zehn Schultage ohne Eintrag, Entfall zählt nicht", async () => {
    const open = await openLessons(h.db, "u-jana.brandt", FRIDAY);
    expect(open.map((s) => [s.subjectId, s.date])).toEqual([
      ["E", "2026-10-09"],
      ["D", "2026-09-28"],
    ]);
    // vor Stundenende ist die heutige Stunde noch nicht offen
    expect((await openLessons(h.db, "u-jana.brandt", fromBerlinLocal("2026-10-09T08:00"))).map((s) => s.subjectId)).toEqual(["D"]);
    expect(await openLessons(h.db, "u-tobias.kleine", FRIDAY)).toEqual([]);
  });

  it("Gong nur freitags, nur an Lehrkräfte mit Lücken, gebündelt (Vorwoche wird ersetzt)", async () => {
    expect(await runGapReminders(h.db, fromBerlinLocal("2026-10-08T16:00"))).toBe(0);
    expect(await runGapReminders(h.db, FRIDAY)).toBe(1);
    const mine = await h.db.select().from(notifications).where(eq(notifications.bundleKey, GAP_BUNDLE_KEY));
    expect(mine.map((n) => [n.userId, n.title, n.href])).toEqual([["u-jana.brandt", "Klassenbuch: 2 Stunden ohne Eintrag", "/klassenbuch#offen"]]);
    // Woche später (jetzt fehlt auch Mathe vom 14.10.): je Person eine Nachricht, neuer Stand
    expect(await runGapReminders(h.db, fromBerlinLocal("2026-10-16T16:00"))).toBe(2);
    const again = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, "u-jana.brandt"), eq(notifications.bundleKey, GAP_BUNDLE_KEY)));
    expect(again).toHaveLength(1);
  });

  it("Job „klassenbuch-luecken“ freitags ab 15:30, nur bei eingeschaltetem Modul", async () => {
    const job = SCHEDULED_JOBS.find((j) => j.name === "klassenbuch-luecken")!;
    expect(job).toMatchObject({ at: "15:30", until: "20:00" });
    await setModuleEnabled(h.db, manifest, false);
    expect(await job.run(h.db, FRIDAY)).toBeUndefined();
    await setModuleEnabled(h.db, manifest, true);
    expect(await job.run(h.db, FRIDAY)).toBe(1);
  });
});
