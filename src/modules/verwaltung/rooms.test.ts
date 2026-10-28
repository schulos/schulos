import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, periods, rooms, subjects, timetableLessons, users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { createGroup } from "./groups";
import { createRoom, deleteRoom, getRoom, listRooms, roomUsage, setRoomActive, updateRoom, type RoomInput } from "./rooms";
import { ValidationError } from "./users";

const room = (code: string, more: Partial<RoomInput> = {}): RoomInput => ({ code, name: `Raum ${code}`, kind: "klassenraum", accessible: false, active: true, ...more });

describe("Stammdaten · Räume", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "u-admin", name: "Admin", email: "admin@test", role: "admin" });
    await h.db.insert(subjects).values({ id: "CH", name: "Chemie", color: "#0C8599" });
    await h.db.insert(periods).values({ nr: 1, startsAt: "08:00", endsAt: "08:45" });
  });
  afterAll(() => h.close());

  it("legt an (Ausstattung seit RS-05 im Steckbrief), validiert", async () => {
    await createRoom(h.db, "u-admin", room("NW2", { name: "Chemie-Raum", kind: "nw", building: " Naturwissenschaften ", floor: "EG", capacity: "28", accessible: true }));
    expect(await getRoom(h.db, "NW2")).toEqual({
      id: "NW2",
      name: "Chemie-Raum",
      kind: "nw",
      building: "Naturwissenschaften",
      floor: "EG",
      capacity: 28,
      accessible: true,
      active: true,
    });
    try {
      await createRoom(h.db, "u-admin", room("nw2", { name: " ", kind: "keller", capacity: "-3" }));
      throw new Error("erwartet ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors).toEqual({
        code: "Kürzel schon vergeben",
        name: "Name angeben",
        kind: "Raumart wählen",
        capacity: "Kapazität 1–2000 oder leer",
      });
    }
  });

  it("Umbenennen zieht den Stundenplan mit; verplante Räume nicht löschbar", async () => {
    const groupId = await createGroup(h.db, "u-admin", { name: "Kurs CH", kind: "kurs" });
    await h.db.insert(timetableLessons).values({ groupId, weekday: 1, periodNr: 1, subjectId: "CH", roomId: "NW2", validFrom: "2026-08-01" });
    expect(await updateRoom(h.db, "u-admin", "NW2", room("CH1", { name: "Chemie-Raum", kind: "nw", capacity: "" }))).toBe("CH1");
    const [lesson] = await h.db.select({ roomId: timetableLessons.roomId }).from(timetableLessons);
    expect(lesson!.roomId).toBe("CH1");
    expect((await getRoom(h.db, "CH1"))!.capacity).toBeNull();
    expect((await roomUsage(h.db)).get("CH1")).toBe(1);
    await expect(deleteRoom(h.db, "u-admin", "CH1")).rejects.toMatchObject({ fieldErrors: { code: expect.stringContaining("inaktiv") } });
    // das eigene Kürzel gilt nicht als „schon vergeben“
    await updateRoom(h.db, "u-admin", "CH1", room("CH1", { name: "Chemie", kind: "nw" }));
  });

  it("inaktive Räume fehlen in Auswahllisten, bleiben aber in der Verwaltung", async () => {
    await createRoom(h.db, "u-admin", room("101"));
    await createRoom(h.db, "u-admin", room("ALT", { active: false }));
    expect((await timetableMasterData(h.db)).rooms.map((r) => r.id)).toEqual(["101", "CH1"]);
    expect((await listRooms(h.db)).map((r) => r.id).sort()).toEqual(["101", "ALT", "CH1"]);
    expect((await listRooms(h.db, { activeOnly: true, kind: "klassenraum" })).map((r) => r.id)).toEqual(["101"]);
    expect((await listRooms(h.db, { q: "chem" })).map((r) => r.id)).toEqual(["CH1"]);
    await deleteRoom(h.db, "u-admin", "ALT");
    expect(await h.db.select({ id: rooms.id }).from(rooms)).toHaveLength(2);
  });

  it("Stilllegen und Wiederinbetriebnahme: verplanter Raum bleibt erhalten, Audit, unbekannter Raum", async () => {
    await createRoom(h.db, "u-admin", room("ST1"));
    await setRoomActive(h.db, "u-admin", "ST1", false);
    expect((await getRoom(h.db, "ST1"))?.active).toBe(false);
    expect((await timetableMasterData(h.db)).rooms.map((r) => r.id)).not.toContain("ST1");
    await setRoomActive(h.db, "u-admin", "ST1", false); // idempotent
    await setRoomActive(h.db, "u-admin", "ST1", true);
    expect((await getRoom(h.db, "ST1"))?.active).toBe(true);
    const acts = (await h.db.select({ a: auditLog.action }).from(auditLog).where(eq(auditLog.target, "ST1"))).map((r) => r.a);
    expect(acts).toContain("verwaltung.room.deactivate");
    expect(acts).toContain("verwaltung.room.activate");
    expect(acts.filter((a) => a === "verwaltung.room.deactivate")).toHaveLength(1);
    await expect(setRoomActive(h.db, "u-admin", "NIX", false)).rejects.toBeInstanceOf(ValidationError);
    await deleteRoom(h.db, "u-admin", "ST1");
  });
});
