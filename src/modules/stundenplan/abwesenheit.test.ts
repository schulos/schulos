import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { absenceCovers, classifyNeeds, createAbsence, deleteAbsence, needsOn, type Absence, type NeedLesson } from "./abwesenheit";
import { saveSubstitution, teacherAvailability } from "./vertretung";

const MO = "2026-10-05";

describe("absenceCovers / classifyNeeds", () => {
  const abs = (p: Partial<Absence>): Absence => ({
    id: "a",
    teacherId: null,
    groupId: null,
    label: "",
    startsOn: MO,
    endsOn: MO,
    fromPeriod: null,
    toPeriod: null,
    reason: "krank",
    note: null,
    ...p,
  });
  const lesson = (lessonId: string, periodNr: number, groupId: string, teacherId: string): NeedLesson => ({
    lessonId,
    periodNr,
    groupId,
    groupName: groupId,
    subjectName: "Deutsch",
    teacherId,
    teacherCode: teacherId.toUpperCase(),
    roomId: null,
  });

  it("stundenweise und mehrtägig", () => {
    expect(absenceCovers(abs({ fromPeriod: 3, toPeriod: 4 }), MO, 2)).toBe(false);
    expect(absenceCovers(abs({ fromPeriod: 3, toPeriod: 4 }), MO, 4)).toBe(true);
    expect(absenceCovers(abs({ endsOn: "2026-10-07" }), "2026-10-07", 8)).toBe(true);
  });

  it("Lehrkraft fehlt → offen (bzw. schon geregelt); Gruppe fehlt → Freisetzung, auch wenn die Lehrkraft fehlt", () => {
    const n = classifyNeeds(
      [lesson("1", 1, "7a", "bra"), lesson("2", 2, "7b", "bra"), lesson("3", 3, "7a", "bra"), lesson("4", 3, "9a", "kle"), lesson("5", 1, "9a", "kle")],
      new Map([["3", "substitute" as const]]),
      [abs({ teacherId: "bra" }), abs({ groupId: "7b", reason: "exkursion" }), abs({ groupId: "9a", reason: "praktikum", fromPeriod: 3, toPeriod: 6 })],
      MO,
    );
    expect(n.open.map((x) => `${x.lessonId}:${x.status}`)).toEqual(["1:open", "3:substitute"]);
    expect(n.released.map((x) => x.lessonId)).toEqual(["2", "4"]);
  });

  it("Vertretung durch eine abwesende Lehrkraft fällt aus → wieder offen", () => {
    const n = classifyNeeds([lesson("5", 2, "9a", "kle")], new Map([["5", "substitute" as const]]), [abs({ teacherId: "bra", label: "BRA" })], MO, new Map([["5", "bra"]]));
    expect(n.open).toMatchObject([{ lessonId: "5", status: "open", substituteAbsent: "BRA" }]);
  });
});

describe("Abwesenheiten (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableSubstitutions);
  });
  afterAll(() => h.close());

  it("prüft Eingaben – Grund passend zum Ziel, genau ein Ziel", async () => {
    const fe = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        if (e instanceof ValidationError) return e.fieldErrors;
        throw e;
      }
      throw new Error("keine ValidationError");
    };
    const base = { teacherId: "u-jana.brandt", groupId: null, startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "krank", note: null };
    expect(await fe(createAbsence(h.db, "u-admin", { ...base, groupId: "g-7b" }))).toHaveProperty("target");
    expect(await fe(createAbsence(h.db, "u-admin", { ...base, teacherId: null, groupId: "g-7b" }))).toHaveProperty("reason"); // „krank“ nicht für Klassen
    expect(await fe(createAbsence(h.db, "u-admin", { ...base, teacherId: "u-lea.schaefer" }))).toHaveProperty("target");
    expect(await fe(createAbsence(h.db, "u-admin", { ...base, fromPeriod: 2 }))).toHaveProperty("toPeriod");
  });

  it("kranke Lehrkraft → offene Stunden; Klasse auf Exkursion → Freisetzung, deren Lehrkraft kann vertreten", async () => {
    const all = (await h.db.select().from(timetableLessons)).filter((l) => l.weekday === 0);
    const jana = all.filter((l) => l.teacherId === "u-jana.brandt");
    expect(jana.length).toBeGreaterThan(0);
    const absence = await createAbsence(h.db, "u-admin", { teacherId: "u-jana.brandt", groupId: null, startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    let n = await needsOn(h.db, MO);
    expect(n.open.map((x) => x.lessonId).sort()).toEqual(jana.map((l) => l.id).sort());
    expect(n.open.every((x) => x.status === "open" && x.absence.reason === "krank")).toBe(true);

    // eine andere Klasse ist zur selben Stunde auf Exkursion → ihre Lehrkraft wird frei und kann vertreten
    const target = n.open[0]!;
    const parallel = all.find((l) => l.periodNr === target.periodNr && l.groupId !== target.groupId && l.teacherId && l.teacherId !== "u-jana.brandt")!;
    const before = (await teacherAvailability(h.db, target.lessonId, MO)).find((t) => t.id === parallel.teacherId)!;
    expect(before.free).toBe(false);
    await createAbsence(h.db, "u-admin", { teacherId: null, groupId: parallel.groupId, startsOn: MO, endsOn: MO, fromPeriod: target.periodNr, toPeriod: target.periodNr, reason: "exkursion", note: "Zoo" });
    n = await needsOn(h.db, MO);
    expect(n.released.map((x) => x.lessonId)).toContain(parallel.id);
    expect((await teacherAvailability(h.db, target.lessonId, MO)).find((t) => t.id === parallel.teacherId)!.free).toBe(true);
    // abwesende Lehrkraft ist nicht wählbar
    expect((await teacherAvailability(h.db, parallel.id, MO)).find((t) => t.id === "u-jana.brandt")?.free ?? false).toBe(false);

    await saveSubstitution(h.db, "u-admin", { lessonId: target.lessonId, date: MO, kind: "substitute", substituteId: parallel.teacherId, roomId: null, note: null });
    n = await needsOn(h.db, MO);
    expect(n.open.find((x) => x.lessonId === target.lessonId)!.status).toBe("substitute");

    await deleteAbsence(h.db, "u-admin", absence);
    expect((await needsOn(h.db, MO)).open).toEqual([]);
    const log = await h.db.select({ action: auditLog.action, meta: auditLog.meta }).from(auditLog).where(eq(auditLog.action, "stundenplan.absence.create"));
    expect(log).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain("krank");
  });
});
