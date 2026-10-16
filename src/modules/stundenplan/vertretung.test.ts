import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { listSlots } from "./service";
import { deleteSubstitution, planDays, saveSubstitution, substitutionsOn, teacherAvailability } from "./vertretung";

const MO = "2026-10-05";
const DI = "2026-10-06";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Vertretungen", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  const day = (target: Parameters<typeof listSlots>[1]) => listSlots(h.db, target, MO, DI);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons);
    const base = { weekday: 0, validFrom: "2026-08-01", validUntil: null };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" },
        { ...base, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "106" },
        { ...base, groupId: "g-9a", periodNr: 1, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "201" },
        { ...base, groupId: "g-9a", periodNr: 2, subjectId: "E", teacherId: "u-sophie.wagner", roomId: "201" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.groupId}-${r.periodNr}`] = r.id;
  }, 60_000);
  afterAll(() => h.close());

  it("Vertretung: Klasse sieht die Änderung, Vertretung bekommt die Stunde, Lehrkraft sieht sie als abgegeben; Gong an alle", async () => {
    await saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-2"]!, date: MO, kind: "substitute", substituteId: "u-jana.brandt", roomId: null, note: "Arbeitsheft S. 24" });
    const lea = (await day({ kind: "user", id: "u-lea.schaefer" })).find((s) => s.periodNr === 2)!;
    expect(lea.change).toMatchObject({ kind: "substitute", substituteCode: "BRA", note: "Arbeitsheft S. 24" });
    expect(lea.perspective).toBeUndefined();
    const bra = await day({ kind: "user", id: "u-jana.brandt" });
    expect(bra.map((s) => `${s.periodNr} ${s.groupName} ${s.perspective ?? "-"}`)).toEqual(["1 Klasse 7b -", "2 Klasse 7b covering"]);
    const kle = await day({ kind: "teacher", id: "u-tobias.kleine" });
    expect(kle.find((s) => s.groupId === "g-7b")!.perspective).toBe("away");
    const gong = await h.db.select().from(notifications).where(eq(notifications.userId, "u-lea.schaefer"));
    expect(gong.map((n) => n.title)).toContain("Vertretung Mo., 5.10., 2. Std: Mathematik (7b)");
    expect(gong.find((n) => n.title.startsWith("Vertretung"))!.body).toBe("bei Jana Brandt · Arbeitsheft S. 24");
    for (const t of ["u-tobias.kleine", "u-jana.brandt"]) {
      expect((await h.db.select().from(notifications).where(eq(notifications.userId, t))).some((n) => n.moduleId === "stundenplan")).toBe(true);
    }
  });

  it("Vertretung nur durch freie Lehrkräfte – wer selbst Unterricht hat, ist frei, sobald dieser entfällt", async () => {
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-1"]!, date: MO, kind: "substitute", substituteId: "u-tobias.kleine", roomId: null, note: null }))).toEqual({
      substituteId: "Die Lehrkraft unterrichtet zu dieser Zeit selbst",
    });
    expect((await teacherAvailability(h.db, ids["g-7b-1"]!, MO)).find((t) => t.code === "KLE")!.free).toBe(false);
    await saveSubstitution(h.db, "u-admin", { lessonId: ids["g-9a-1"]!, date: MO, kind: "cancel", substituteId: null, roomId: null, note: null });
    expect((await teacherAvailability(h.db, ids["g-7b-1"]!, MO)).find((t) => t.code === "KLE")!.free).toBe(true);
    await saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-1"]!, date: MO, kind: "substitute", substituteId: "u-tobias.kleine", roomId: null, note: null });
    expect((await day({ kind: "group", id: "g-9a" })).find((s) => s.periodNr === 1)!.change?.kind).toBe("cancel");
  });

  it("Raumänderung prüft Belegung; Raumplan zeigt die Stunde im neuen Raum", async () => {
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-2"]!, date: MO, kind: "room", substituteId: null, roomId: "201", note: null }))).toEqual({
      roomId: "Raum 201 ist zu dieser Zeit belegt",
    });
    await saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-2"]!, date: MO, kind: "substitute", substituteId: "u-jana.brandt", roomId: "202", note: null });
    expect((await day({ kind: "room", id: "202" })).map((s) => `${s.periodNr} ${s.groupName} ${s.perspective}`)).toEqual(["2 Klasse 7b covering"]);
    expect((await day({ kind: "room", id: "106" })).find((s) => s.periodNr === 2)!.perspective).toBe("away");
    // 9a 1. Std entfällt → Raum 201 ist dann frei
    await saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-1"]!, date: MO, kind: "room", substituteId: null, roomId: "201", note: null });
  });

  it("validiert Tag, Art und Pflichtfelder", async () => {
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-1"]!, date: DI, kind: "cancel", substituteId: null, roomId: null, note: null }))).toEqual({
      date: "An diesem Tag findet die Stunde nicht statt",
    });
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-1"]!, date: MO, kind: "substitute", substituteId: null, roomId: null, note: null }))).toHaveProperty("substituteId");
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: ids["g-7b-1"]!, date: MO, kind: "room", substituteId: null, roomId: "106", note: null }))).toEqual({
      roomId: "Der Raum ist derselbe wie sonst",
    });
  });

  it("Übersicht eines Tages, Aufheben", async () => {
    const list = await substitutionsOn(h.db, [MO]);
    expect(list.map((s) => `${s.groupName} ${s.periodNr} ${s.kind}`)).toEqual(["Klasse 7b 1 room", "Klasse 7b 2 substitute", "Klasse 9a 1 cancel"]);
    await deleteSubstitution(h.db, "u-admin", list[0]!.id);
    expect((await day({ kind: "group", id: "g-7b" })).find((s) => s.periodNr === 1)!.change).toBeUndefined();
  });
  it("Kopplung: Vertretung und Entfall gelten für alle Gruppen derselben Lehrkraft, nicht für den Teamteaching-Partner", async () => {
    const base = { weekday: 0, periodNr: 5, validFrom: "2026-08-01", validUntil: null, couplingId: "k-rel" };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, groupId: "g-7a", subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" },
        { ...base, groupId: "g-7b", subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" },
        { ...base, groupId: "g-7b", subjectId: "D", teacherId: "u-petra.lindner", roomId: "112" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, subjectId: timetableLessons.subjectId });
    const rel7a = rows.find((r) => r.groupId === "g-7a")!.id;
    const rel7b = rows.find((r) => r.groupId === "g-7b" && r.subjectId === "REL")!.id;
    const d7b = rows.find((r) => r.subjectId === "D")!.id;
    // Vertretung darf nicht der Partner in derselben Kopplung sein (unterrichtet selbst)
    expect((await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: rel7a, date: MO, kind: "substitute", substituteId: "u-petra.lindner", roomId: null, note: null }))).substituteId).toMatch(/unterrichtet/);
    await saveSubstitution(h.db, "u-admin", { lessonId: rel7a, date: MO, kind: "substitute", substituteId: "u-sophie.wagner", roomId: null, note: null });
    const subs = await substitutionsOn(h.db, [MO]);
    expect(subs.filter((x) => [rel7a, rel7b].includes(x.lessonId)).map((x) => `${x.groupName} ${x.substituteCode}`).sort()).toEqual(["Klasse 7a WAG", "Klasse 7b WAG"]);
    expect(subs.some((x) => x.lessonId === d7b)).toBe(false);
    // Q5-03: Lea hat an dem Tag schon Änderungen → weiterhin eine Nachricht, jetzt als Tagesübersicht (nur ihre Gruppe)
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-lea.schaefer"), eq(notifications.moduleId, "stundenplan")));
    expect(gong).toHaveLength(1);
    expect(gong[0]!.title).toMatch(/^Vertretungsplan Mo\., 5\.10\.: \d Änderungen$/);
    expect(gong[0]!.body).toContain("5. Std Religion/Philosophie (7b): Vertretung – bei Sophie Wagner");
    // Vertretung sieht beide Gruppen; RIC ist für beide frei → Verfügbarkeit
    const wag = (await day({ kind: "teacher", id: "u-sophie.wagner" })).filter((x) => x.periodNr === 5);
    expect(wag.map((x) => x.groupName).sort()).toEqual(["Klasse 7a", "Klasse 7b"]);
    // Löschen nimmt beide zurück
    await deleteSubstitution(h.db, "u-admin", subs.find((x) => x.lessonId === rel7b)!.id);
    expect((await substitutionsOn(h.db, [MO])).some((x) => [rel7a, rel7b].includes(x.lessonId))).toBe(false);
    expect((await teacherAvailability(h.db, rel7a, MO)).find((t) => t.id === "u-petra.lindner")!.free).toBe(false);
  });
});

describe("planDays", () => {
  it("heute + nächster Schultag; Wochenende → Montag + Dienstag; Freitag → Montag", () => {
    expect(planDays("2026-10-06")).toEqual(["2026-10-06", "2026-10-07"]);
    expect(planDays("2026-10-09")).toEqual(["2026-10-09", "2026-10-12"]);
    expect(planDays("2026-10-03")).toEqual(["2026-10-05", "2026-10-06"]);
    expect(planDays("2026-10-04")).toEqual(["2026-10-05", "2026-10-06"]);
  });

});
