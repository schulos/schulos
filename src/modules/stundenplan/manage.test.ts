import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { couplingParts, createLesson, deleteCoupling, deleteLesson, lessonsOfGroup, saveCoupling, slotsOverlap, suggestRoom, updateLesson, type LessonInput } from "./manage";

const base: LessonInput = {
  groupId: "g-7b",
  weekday: 0,
  periodNr: 1,
  subjectId: "D",
  teacherId: "u-jana.brandt",
  roomId: "112",
  week: "all",
  validFrom: "2026-08-01",
  validUntil: "2027-07-31",
};

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("slotsOverlap", () => {
  const s = { weekday: 0, periodNr: 1, week: "all" as const, validFrom: "2026-08-01", validUntil: null };
  it("gleicher Slot, A/B-Woche, Gültigkeit", () => {
    expect(slotsOverlap(s, { ...s })).toBe(true);
    expect(slotsOverlap(s, { ...s, periodNr: 2 })).toBe(false);
    expect(slotsOverlap({ ...s, week: "A" }, { ...s, week: "B" })).toBe(false);
    expect(slotsOverlap({ ...s, week: "A" }, s)).toBe(true);
    expect(slotsOverlap({ ...s, validUntil: "2026-12-31" }, { ...s, validFrom: "2027-01-01" })).toBe(false);
    expect(slotsOverlap({ ...s, validUntil: "2026-12-31" }, { ...s, validFrom: "2026-12-31" })).toBe(true);
  });
});

describe("suggestRoom", () => {
  const rooms = [
    { id: "106", kind: "klassenraum" },
    { id: "NW0", kind: "nw", active: false },
    { id: "NW1", kind: "nw" },
    { id: "TH1", kind: "sport" },
  ];
  it("Fachraum nach Raumwunsch des Fachs, sonst Stammraum", () => {
    expect(suggestRoom({ roomKind: "nw" }, "106", rooms)).toBe("NW1");
    expect(suggestRoom({ roomKind: "sport" }, null, rooms)).toBe("TH1");
    expect(suggestRoom({ roomKind: "klassenraum" }, "106", rooms)).toBe("106");
    expect(suggestRoom({ roomKind: null }, "106", rooms)).toBe("106");
    expect(suggestRoom({ roomKind: "musik" }, "106", rooms)).toBe("106");
    expect(suggestRoom(undefined, null, rooms)).toBeNull();
  });
});

describe("Stundenplan-Pflege", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons); // eigener, überschaubarer Plan statt Demo-Stundenplan
  }, 60_000);
  afterAll(() => h.close());

  it("legt eine Stunde an und protokolliert", async () => {
    await createLesson(h.db, "u-admin", base);
    const rows = await lessonsOfGroup(h.db, "g-7b", "2026-10-05");
    expect(rows.map((r) => `${r.l.weekday}/${r.l.periodNr} ${r.l.subjectId} ${r.teacherCode}`)).toEqual(["0/1 D BRA"]);
    const log = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.lesson.create"));
    expect(log).toHaveLength(1);
  });

  it("verweigert Lehrkraft, Raum und Gruppe doppelt", async () => {
    expect(await fieldErrors(createLesson(h.db, "u-admin", { ...base, groupId: "g-9a", roomId: "201" }))).toEqual({
      teacherId: expect.stringMatching(/BRA unterrichtet Mo 1\. Stunde schon in Klasse 7b/),
    });
    expect(await fieldErrors(createLesson(h.db, "u-admin", { ...base, groupId: "g-9a", teacherId: "u-tobias.kleine" }))).toEqual({
      roomId: expect.stringMatching(/Raum 112 ist Mo 1\. Stunde schon von Klasse 7b belegt/),
    });
    expect(await fieldErrors(createLesson(h.db, "u-admin", { ...base, subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" }))).toEqual({
      periodNr: expect.stringMatching(/Klasse 7b hat Mo 1\. Stunde schon eine Stunde/),
    });
  });

  it("erlaubt andere A/B-Woche und spätere Gültigkeit", async () => {
    await createLesson(h.db, "u-admin", { ...base, periodNr: 2, week: "A" });
    await createLesson(h.db, "u-admin", { ...base, periodNr: 2, week: "B", subjectId: "E" });
    await createLesson(h.db, "u-admin", { ...base, groupId: "g-9a", roomId: "201", validFrom: "2027-08-01", validUntil: null });
    expect((await lessonsOfGroup(h.db, "g-7b", "2026-10-05")).length).toBe(3);
  });

  it("validiert Eingaben", async () => {
    const fe = await fieldErrors(
      createLesson(h.db, "u-admin", { ...base, weekday: 5, periodNr: 99, subjectId: "XX", teacherId: "u-lea.schaefer", roomId: "999", validUntil: "2026-01-01" }),
    );
    expect(Object.keys(fe).sort()).toEqual(["periodNr", "roomId", "subjectId", "teacherId", "validUntil", "weekday"]);
  });

  it("ändern kollidiert nicht mit sich selbst; löschen", async () => {
    const first = (await lessonsOfGroup(h.db, "g-7b", "2026-10-05")).find((r) => r.l.subjectId === "D" && r.l.periodNr === 1);
    await updateLesson(h.db, "u-admin", first!.l.id, { ...base, roomId: "111" });
    expect((await lessonsOfGroup(h.db, "g-7b", "2026-10-05")).find((r) => r.l.id === first!.l.id)!.l.roomId).toBe("111");
    expect(await fieldErrors(updateLesson(h.db, "u-admin", first!.l.id, { ...base, periodNr: 2 }))).toHaveProperty("periodNr");
    await deleteLesson(h.db, "u-admin", first!.l.id);
    expect((await lessonsOfGroup(h.db, "g-7b", "2026-10-05")).some((r) => r.l.id === first!.l.id)).toBe(false);
  });

  it("Kopplung: geteilte Klasse, eine Lehrkraft für zwei Gruppen, Teamteaching; Kollisionen nach außen", async () => {
    const slot = { weekday: 1, periodNr: 3, week: "all" as const, validFrom: "2026-08-01", validUntil: "2027-07-31" };
    const id = await saveCoupling(h.db, "u-admin", null, {
      ...slot,
      parts: [
        { groupId: "g-7b", subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" },
        { groupId: "g-7a", subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" },
        { groupId: "g-7b", subjectId: "D", teacherId: "u-jana.brandt", roomId: "112" },
        { groupId: "g-7b", subjectId: "D", teacherId: "u-petra.lindner", roomId: "112" },
      ],
    });
    let parts = await couplingParts(h.db, [id]);
    expect(parts.map((p) => `${p.groupName} ${p.subjectId} ${p.teacherCode} ${p.roomId}`)).toEqual([
      "Klasse 7a REL RIC 110",
      "Klasse 7b D BRA 112",
      "Klasse 7b D LIN 112",
      "Klasse 7b REL RIC 110",
    ]);
    // Einzelstunde in denselben Slot: Gruppe/Lehrkraft/Raum kollidieren mit der Kopplung
    expect(await fieldErrors(createLesson(h.db, "u-admin", { ...base, ...slot, groupId: "g-7a", teacherId: "u-tobias.kleine", roomId: "201" }))).toEqual({
      periodNr: expect.stringMatching(/Klasse 7a hat Di 3\. Stunde schon eine Stunde \(geteilte Klasse\? Dann eine Kopplung anlegen\)/),
    });
    // gekoppelte Stunde nur über die Kopplung bearbeiten
    expect(await fieldErrors(updateLesson(h.db, "u-admin", parts[0]!.id, { ...base, ...slot, groupId: "g-7a", subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" }))).toHaveProperty("id");

    // Teile prüfen: weniger als zwei, Lehrkraft in zwei Räumen, doppelter Teil, Kollision nach außen
    expect(await fieldErrors(saveCoupling(h.db, "u-admin", id, { ...slot, parts: [parts[0]!] }))).toHaveProperty("parts");
    const fe = await fieldErrors(
      saveCoupling(h.db, "u-admin", null, {
        ...slot,
        weekday: 2,
        parts: [
          { groupId: "g-9a", subjectId: "M", teacherId: "u-tobias.kleine", roomId: "201" },
          { groupId: "g-9b", subjectId: "M", teacherId: "u-tobias.kleine", roomId: "202" },
          { groupId: "g-9a", subjectId: "M", teacherId: "u-tobias.kleine", roomId: "201" },
        ],
      }),
    );
    expect(fe).toMatchObject({ "p1-roomId": expect.stringMatching(/zwei Räumen/), "p2-groupId": expect.stringMatching(/schon in der Kopplung/) });
    await createLesson(h.db, "u-admin", { ...base, weekday: 2, periodNr: 3, groupId: "g-9b", teacherId: "u-murat.yilmaz", roomId: "301", subjectId: "IF" });
    const outside = await fieldErrors(
      saveCoupling(h.db, "u-admin", null, {
        ...slot,
        weekday: 2,
        parts: [
          { groupId: "g-9a", subjectId: "M", teacherId: "u-tobias.kleine", roomId: "201" },
          { groupId: "g-9b", subjectId: "M", teacherId: "u-tobias.kleine", roomId: "201" },
        ],
      }),
    );
    expect(outside["p1-groupId"]).toMatch(/Klasse 9b hat Mi 3\. Stunde schon eine Stunde/);

    // ändern: Teil entfernen, Teil hinzufügen, Slot verschieben – bestehende Zeilen behalten ihre id
    const keep = parts.filter((p) => p.teacherCode !== "LIN");
    await saveCoupling(h.db, "u-admin", id, { ...slot, periodNr: 4, parts: [...keep, { groupId: "g-7a", subjectId: "D", teacherId: "u-sophie.wagner", roomId: "111" }] });
    parts = await couplingParts(h.db, [id]);
    expect(parts).toHaveLength(4);
    expect(parts.filter((p) => keep.some((k) => k.id === p.id))).toHaveLength(3);
    const rows = await h.db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, id));
    expect(rows.every((r) => r.periodNr === 4)).toBe(true);

    // Einzelstunde zur Kopplung erweitern; Löschen bis auf einen Teil löst die Kopplung auf
    const single = await createLesson(h.db, "u-admin", { ...base, weekday: 3, periodNr: 5, subjectId: "SP", teacherId: "u-daniel.okafor", roomId: "TH1" });
    const ext = await saveCoupling(h.db, "u-admin", null, {
      ...slot,
      weekday: 3,
      periodNr: 5,
      parts: [
        { id: single, groupId: "g-7b", subjectId: "SP", teacherId: "u-daniel.okafor", roomId: "TH1" },
        { groupId: "g-7a", subjectId: "SP", teacherId: "u-daniel.okafor", roomId: "TH1" },
      ],
    });
    const extParts = await couplingParts(h.db, [ext]);
    expect(extParts.map((p) => p.id)).toContain(single);
    await deleteLesson(h.db, "u-admin", extParts.find((p) => p.id !== single)!.id);
    const [left] = await h.db.select().from(timetableLessons).where(eq(timetableLessons.id, single));
    expect(left!.couplingId).toBeNull();

    await deleteCoupling(h.db, "u-admin", id);
    expect(await couplingParts(h.db, [id])).toEqual([]);
    const log = await h.db.select({ a: auditLog.action }).from(auditLog);
    expect(log.map((l) => l.a)).toEqual(expect.arrayContaining(["stundenplan.coupling.create", "stundenplan.coupling.update", "stundenplan.coupling.delete"]));
  });

  it("blendet abgelaufene Stunden in der Pflege aus", async () => {
    await createLesson(h.db, "u-admin", { ...base, weekday: 4, periodNr: 6, validFrom: "2026-08-01", validUntil: "2026-09-30" });
    expect((await lessonsOfGroup(h.db, "g-7b", "2026-10-05")).some((r) => r.l.weekday === 4)).toBe(false);
  });
});
