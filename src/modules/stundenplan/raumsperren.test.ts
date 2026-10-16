import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { occupancyOn, type RoomHit } from "./raeume";
import { affectedLessons, blockCovers, createRoomBlock, deleteRoomBlock, listRoomBlocks, rankAlternatives, roomBlockAt } from "./raumsperren";
import { saveSubstitution } from "./vertretung";

describe("blockCovers / rankAlternatives", () => {
  it("ganztägig oder nur einzelne Stunden, Zeitraum einschließlich", () => {
    const b = { startsOn: "2026-10-05", endsOn: "2026-10-06", fromPeriod: null, toPeriod: null };
    expect(blockCovers(b, "2026-10-06", 8)).toBe(true);
    expect(blockCovers(b, "2026-10-07", 1)).toBe(false);
    const p = { ...b, fromPeriod: 3, toPeriod: 4 };
    expect([2, 3, 4, 5].map((n) => blockCovers(p, "2026-10-05", n))).toEqual([false, true, true, false]);
  });

  it("Ausweichräume: gleiche Art, dann gleiches Gebäude/Etage, dann kleinste Größe", () => {
    const r = (id: string, kind: RoomHit["kind"], building: string | null, floor: string | null, capacity: number): RoomHit => ({
      id, name: id, kind, building, floor, capacity, equipment: [], accessible: false, active: true, freePeriods: 3,
    });
    const original = r("NW1", "nw", "A", "EG", 30);
    const ranked = rankAlternatives(original, [r("101", "klassenraum", "A", "EG", 28), r("NW3", "nw", "B", "1. OG", 30), r("NW2", "nw", "A", "1. OG", 32), r("NW4", "nw", "A", "EG", 34)]);
    expect(ranked.map((x) => x.id)).toEqual(["NW4", "NW2", "NW3", "101"]);
  });
});

describe("Raumsperrungen (Demo-Schule)", () => {
  let h: DbHandle;
  const MO = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableSubstitutions);
  });
  afterAll(() => h.close());

  it("prüft Eingaben", async () => {
    const fe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        if (e instanceof ValidationError) return e.fieldErrors;
        throw e;
      }
      throw new Error("keine ValidationError");
    };
    const base = { roomId: "106", startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "pruefung", note: null };
    expect(await fe(createRoomBlock(h.db, "u-admin", { ...base, endsOn: "2026-10-01" }))).toHaveProperty("endsOn");
    expect(await fe(createRoomBlock(h.db, "u-admin", { ...base, roomId: "nope" }))).toHaveProperty("roomId");
    expect(await fe(createRoomBlock(h.db, "u-admin", { ...base, fromPeriod: 3 }))).toHaveProperty("toPeriod");
    expect(await fe(createRoomBlock(h.db, "u-admin", { ...base, fromPeriod: 4, toPeriod: 2 }))).toHaveProperty("toPeriod");
    expect(await fe(createRoomBlock(h.db, "u-admin", { ...base, reason: "krank" }))).toHaveProperty("reason");
  });

  it("Sperrung → betroffene Stunden mit Vorschlägen, Belegung zeigt gesperrt, Raumänderung erledigt sie, Sperrraum nicht wählbar", async () => {
    const lessons = (await h.db.select().from(timetableLessons)).filter((l) => l.roomId === "106" && l.weekday === 0);
    expect(lessons.length).toBeGreaterThan(1);
    const id = await createRoomBlock(h.db, "u-admin", { roomId: "106", startsOn: MO, endsOn: MO, fromPeriod: 1, toPeriod: 4, reason: "pruefung", note: "Lernstandserhebung" });
    expect((await listRoomBlocks(h.db, MO)).map((b) => b.id)).toEqual([id]);
    expect(await roomBlockAt(h.db, "106", MO, 5)).toBeNull();

    const affected = await affectedLessons(h.db, MO, 7);
    const covered = lessons.filter((l) => l.periodNr <= 4);
    expect(affected.map((a) => a.lessonId).sort()).toEqual(covered.map((l) => l.id).sort());
    const first = affected[0]!;
    expect(first.suggestions.length).toBeGreaterThan(0);
    expect(first.suggestions[0]!.kind).toBe("klassenraum");
    expect(first.suggestions.every((s) => s.id !== "106" && (s.capacity ?? 0) >= 25)).toBe(true);

    const occ = (await occupancyOn(h.db, MO)).occupancy;
    expect(occ.get("106")?.get(first.periodNr)).toEqual({ kind: "blocked", label: "Gesperrt: Prüfung (Lernstandserhebung)" });

    // Ausweichraum übernehmen → erledigt; in den gesperrten Raum verlegen geht nicht
    await saveSubstitution(h.db, "u-admin", { lessonId: first.lessonId, date: MO, kind: "room", substituteId: null, roomId: first.suggestions[0]!.id, note: "Raumsperrung" });
    expect((await affectedLessons(h.db, MO, 7)).find((a) => a.lessonId === first.lessonId)!.resolved).toBe(true);
    const other = (await h.db.select().from(timetableLessons)).find((l) => l.weekday === 0 && l.periodNr === first.periodNr && l.roomId && l.roomId !== "106")!;
    await expect(saveSubstitution(h.db, "u-admin", { lessonId: other.id, date: MO, kind: "room", substituteId: null, roomId: "106", note: null })).rejects.toThrow(ValidationError);

    await deleteRoomBlock(h.db, "u-admin", id);
    expect(await affectedLessons(h.db, MO, 7)).toEqual([]);
    const log = await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.actorId, "u-admin"));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["stundenplan.roomblock.create", "stundenplan.roomblock.delete"]));
  });
});
