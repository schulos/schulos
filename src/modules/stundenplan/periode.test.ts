import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, classbookEntries, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { saveCoupling } from "./manage";
import { copyPeriod, periodPreview } from "./periode";

describe("Periode kopieren (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  const cutoff = "2027-02-01";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("prüft den Stichtag", async () => {
    await expect(periodPreview(h.db, "2026-10-05", today)).rejects.toBeInstanceOf(ValidationError);
    await expect(copyPeriod(h.db, "u-admin", "kein-datum", today)).rejects.toBeInstanceOf(ValidationError);
  });

  it("teilt laufende Stunden am Stichtag, Kopplungen bekommen neue ids, Vertretungen ab Stichtag ziehen um", async () => {
    const all = await h.db.select().from(timetableLessons);
    const sorted = all.filter((l) => l.groupId === "g-7b").sort((x, y) => x.weekday - y.weekday || x.periodNr - y.periodNr);
    const a = sorted[0];
    const b = sorted.find((l) => l.subjectId !== a!.subjectId);
    // Kopplung aus zwei 7b-Stunden in einem freien Slot, plus eine schon ab dem Stichtag geplante Stunde
    const couplingId = await saveCoupling(h.db, "u-admin", null, {
      weekday: 4,
      periodNr: 8,
      week: "all",
      validFrom: "2026-08-01",
      validUntil: "2027-07-31",
      parts: [
        { groupId: "g-7b", subjectId: a!.subjectId, teacherId: null, roomId: null },
        { groupId: "g-7b", subjectId: b!.subjectId, teacherId: null, roomId: null },
      ],
    });
    await h.db.insert(timetableLessons).values({ groupId: "g-7a", weekday: 4, periodNr: 8, subjectId: a!.subjectId, validFrom: "2027-03-01", validUntil: "2027-07-31" });
    await h.db.insert(timetableSubstitutions).values([
      { lessonId: a!.id, date: "2026-11-02", kind: "cancel" },
      { lessonId: a!.id, date: "2027-02-08", kind: "cancel" },
    ]);
    await h.db.insert(classbookEntries).values({ lessonId: b!.id, date: "2026-10-01", groupId: "g-7b", periodNr: b!.periodNr, subjectId: b!.subjectId, topic: "vorher" });

    const before = (await h.db.select().from(timetableLessons)).length;
    const p = await periodPreview(h.db, cutoff, today);
    expect(p).toMatchObject({ cutoff, split: before - 1, alreadyFuture: 1, moved: 1 });

    expect(await copyPeriod(h.db, "u-admin", cutoff, today)).toBe(before - 1);
    const after = await h.db.select().from(timetableLessons);
    expect(after.length).toBe(before * 2 - 1);
    const oldA = after.find((l) => l.id === a!.id)!;
    expect(oldA).toMatchObject({ validFrom: "2026-08-01", validUntil: "2027-01-31" });
    const newA = after.find((l) => l.id !== a!.id && l.groupId === a!.groupId && l.weekday === a!.weekday && l.periodNr === a!.periodNr && l.validFrom === cutoff)!;
    expect(newA).toMatchObject({ validUntil: "2027-07-31", subjectId: a!.subjectId, teacherId: a!.teacherId, roomId: a!.roomId });

    // Kopplung: Kopie hat eine eigene, gemeinsame id
    const coupled = after.filter((l) => l.weekday === 4 && l.periodNr === 8 && l.groupId === "g-7b");
    const newCoupling = coupled.filter((l) => l.validFrom === cutoff);
    expect(newCoupling).toHaveLength(2);
    expect(new Set(newCoupling.map((l) => l.couplingId)).size).toBe(1);
    expect(newCoupling[0]!.couplingId).not.toBe(couplingId);

    // Vertretung ab Stichtag gehört zur Kopie, die davor bleibt; Klassenbuch-Eintrag davor bleibt
    const subs = await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.kind, "cancel"));
    expect(subs.find((s) => s.date === "2026-11-02")!.lessonId).toBe(a!.id);
    expect(subs.find((s) => s.date === "2027-02-08")!.lessonId).toBe(newA.id);
    const [entry] = await h.db.select().from(classbookEntries).where(eq(classbookEntries.topic, "vorher"));
    expect(entry!.lessonId).toBe(b!.id);
    // schon ab Stichtag geplante Stunde bleibt unverändert
    expect(after.filter((l) => l.groupId === "g-7a" && l.validFrom === "2027-03-01")).toHaveLength(1);

    // zweiter Lauf: nichts läuft mehr über den Stichtag
    expect((await periodPreview(h.db, cutoff, today)).split).toBe(0);
    expect(await copyPeriod(h.db, "u-admin", cutoff, today)).toBe(0);
    const log = await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.action, "stundenplan.period.copy"));
    expect(log).toHaveLength(2);
  });
});
