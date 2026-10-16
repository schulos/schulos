import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { bookingResources, bookings, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { listRooms, occupancyFrom, occupancyOn, searchRooms, weekUtilization, type RoomInfo } from "./raeume";

describe("occupancyFrom / searchRooms", () => {
  const l = (id: string, roomId: string | null, periodNr: number, groupName = "Klasse 7a", subjectName = "Deutsch", couplingId: string | null = null) => ({ id, roomId, periodNr, groupName, subjectName, couplingId });

  it("Entfall gibt frei, Raumänderung belegt den neuen Raum, Kopplung im selben Raum zusammengefasst, Buchung belegt", () => {
    const occ = occupancyFrom(
      [l("a", "101", 1), l("b", "102", 1), l("c", "103", 2), l("d", "201", 3, "Klasse 7a", "Religion", "c1"), l("e", "201", 3, "Klasse 7b", "Religion", "c1")],
      [
        { lessonId: "a", kind: "cancel", roomId: null },
        { lessonId: "c", kind: "room", roomId: "104" },
      ],
      [{ roomId: "101", periodNr: 4, label: "Buchung BRA" }],
    );
    expect(occ.get("101")?.has(1)).toBe(false);
    expect(occ.get("102")?.get(1)).toEqual({ kind: "lesson", label: "Deutsch · Klasse 7a", moved: false });
    expect(occ.get("103")?.has(2)).toBeFalsy();
    expect(occ.get("104")?.get(2)).toMatchObject({ kind: "lesson", moved: true });
    expect(occ.get("201")?.get(3)?.label).toBe("Religion · 7a, 7b");
    expect(occ.get("101")?.get(4)).toEqual({ kind: "booking", label: "Buchung BRA" });
  });

  it("filtert nach freien Stunden, Kapazität, Art, Ausstattung, Barrierefreiheit; kleinste passende zuerst", () => {
    const room = (id: string, p: Partial<RoomInfo> = {}): RoomInfo => ({ id, name: id, kind: "klassenraum", building: null, floor: null, capacity: 30, equipment: [], accessible: false, active: true, ...p });
    const list = [
      room("101", { capacity: 32, equipment: ["beamer"] }),
      room("102", { capacity: 28, equipment: ["beamer"], accessible: true }),
      room("103", { capacity: 20, equipment: ["beamer"] }),
      room("NW1", { kind: "nw", capacity: 30, equipment: ["beamer", "abzug"] }),
      room("ALT", { active: false }),
    ];
    const occ = occupancyFrom([l("x", "102", 3)], [], []);
    const ids = (f: Parameters<typeof searchRooms>[2]) => searchRooms(list, occ, f, [1, 2, 3, 4, 5, 6]).map((r) => r.id);
    expect(ids({ periodNrs: [3], minCapacity: 28, equipment: ["beamer"] })).toEqual(["NW1", "101"]);
    expect(ids({ periodNrs: [2], minCapacity: 28, equipment: ["beamer"], kind: "klassenraum" })).toEqual(["102", "101"]);
    expect(ids({ periodNrs: [2, 3], accessible: true })).toEqual([]);
    expect(ids({ periodNrs: [], equipment: ["abzug"] })).toEqual(["NW1"]);
    expect(searchRooms(list, occ, { periodNrs: [1] }, [1, 2, 3, 4, 5, 6]).find((r) => r.id === "102")!.freePeriods).toBe(5);
  });
});

describe("Raumbelegung (Demo-Schule)", () => {
  let h: DbHandle;
  const MO = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Tagesbelegung aus Plan, Vertretung und Buchung; Ferien geschlossen; Auslastung der Woche", async () => {
    await h.db.delete(timetableSubstitutions); // Demo-Vertretungen des nächsten Schultags ausblenden
    const lesson = (await h.db.select().from(timetableLessons)).find((x) => x.weekday === 0 && x.roomId === "106")!;
    const { occupancy, closed } = await occupancyOn(h.db, MO);
    expect(closed).toBeNull();
    expect(occupancy.get("106")?.get(lesson.periodNr)?.kind).toBe("lesson");

    // Raumänderung nach 015 und eine Buchung von 015 in einer anderen Stunde
    await h.db.insert(timetableSubstitutions).values({ lessonId: lesson.id, date: MO, kind: "room", roomId: "015" });
    const [res] = await h.db.insert(bookingResources).values({ kind: "room", roomId: "015", name: "Raum 015" }).onConflictDoNothing().returning();
    const resId = res?.id ?? (await h.db.select().from(bookingResources)).find((r) => r.roomId === "015")!.id;
    const other = lesson.periodNr === 1 ? 2 : 1;
    await h.db.insert(bookings).values({ resourceId: resId, date: MO, periodNr: other, bookedBy: "u-jana.brandt" });
    const after = (await occupancyOn(h.db, MO)).occupancy;
    expect(after.get("106")?.has(lesson.periodNr) ?? false).toBe(false);
    expect(after.get("015")?.get(lesson.periodNr)).toMatchObject({ kind: "lesson", moved: true });
    expect(after.get("015")?.get(other)).toEqual({ kind: "booking", label: "Buchung BRA" });

    const rooms = await listRooms(h.db);
    const hits = searchRooms(rooms, after, { periodNrs: [lesson.periodNr] }, [1, 2, 3, 4, 5, 6, 7, 8]).map((r) => r.id);
    expect(hits).toContain("106");
    expect(hits).not.toContain("015");

    // gesetzlicher Feiertag (1. Weihnachtstag, Freitag): geschlossen
    expect((await occupancyOn(h.db, "2026-12-25")).closed).toMatch(/Weihnacht/);
    const u = await weekUtilization(h.db, MO);
    expect(u.capacity).toBeGreaterThan(0);
    expect(u.used.get("106")!).toBeGreaterThan(15);
    expect(u.used.get("106")!).toBeLessThanOrEqual(u.capacity);
  });
});
