// SP3-05 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.4, §4 Vorlagen): Halbjahres-Vorlage und Folgeversion „Änderung im laufenden Plan“ (Demo-Schule).
// Ersetzt die Tests von „Periode kopieren“ (P2b-14): statt den gültigen Plan direkt zu teilen, entsteht ein Entwurf ab dem 2. Halbjahr;
// das Veröffentlichen teilt nur geänderte Stunden – Vertretungen ab dem Stichtag ziehen um, Klassenbuch und Vertretungen davor bleiben.
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { classbookEntries, schoolYears, timetableDraftLessons, timetableLessons, timetableSolverRuns, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { createFromTemplate, templateOffers } from "./laufzeit";
import { saveCoupling } from "./manage";
import { LIVE } from "./plan-quelle";
import { approveVersion, submitForReview, type Viewer } from "./planpruefung";
import { validVersion } from "./planversionen";
import { correctionFrom } from "./sofortkorrektur";
import { createRun } from "./solverlauf";
import { publishVersion } from "./veroeffentlichen";
import { clearPublishGate } from "./fahrplan.testing";

describe("Vorlagen „Neues Halbjahr“ und „Änderung im laufenden Plan“ (SP3-05, Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  const now = new Date("2026-10-05T08:00:00Z");
  const term2 = "2027-02-01";
  const yearId = "sj-2026-27";
  const viewer: Viewer = { userId: "u-frank.schulte", manage: true, review: true };
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 120_000);
  afterAll(() => h.close());

  const year = async () => (await h.db.select().from(schoolYears).where(eq(schoolYears.id, yearId)))[0]!;

  it("bietet beide Vorlagen an – Folgeversion ab dem nächsten Schultag, Halbjahr ab dem 2. Halbjahr; danach nicht mehr", async () => {
    const offers = await templateOffers(h.db, await year(), today);
    expect(offers.aenderung).toEqual({ ok: true, validFrom: await correctionFrom(h.db, today), number: "1.1", name: expect.stringMatching(/^Änderung ab /) });
    expect(offers.halbjahr).toEqual({ ok: true, validFrom: term2, number: "2.0", name: "2. Halbjahr" });
    const later = await templateOffers(h.db, await year(), "2027-02-02");
    expect(later.halbjahr).toMatchObject({ ok: false, reason: expect.stringMatching(/hat schon begonnen/) });
    await h.db.update(schoolYears).set({ term2StartsOn: null }).where(eq(schoolYears.id, yearId));
    expect((await templateOffers(h.db, await year(), today)).halbjahr).toMatchObject({ ok: false, reason: expect.stringMatching(/kein Beginn des 2\. Halbjahrs/) });
    await expect(createFromTemplate(h.db, viewer.userId, yearId, "halbjahr", today)).rejects.toBeInstanceOf(ValidationError);
    await h.db.update(schoolYears).set({ term2StartsOn: term2 }).where(eq(schoolYears.id, yearId));
  });

  it("Folgeversion 1.1 aus dem gültigen Plan ab dem nächsten Schultag", async () => {
    const v = await createFromTemplate(h.db, viewer.userId, yearId, "aenderung", today);
    const valid = (await validVersion(h.db, yearId))!;
    expect(v).toMatchObject({ major: 1, minor: 1, status: "entwurf", source: "live_copy", parentVersionId: valid.id, validFrom: await correctionFrom(h.db, today) });
    const rows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, v.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.originLessonId !== null)).toBe(true);
  });

  it("Halbjahr: Entwurf ab dem 2. Halbjahr (Lehraufträge am Stichtag), Veröffentlichen teilt nur Geändertes; Vertretungen/Klassenbuch bleiben zugeordnet", async () => {
    const all = await h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id));
    const sorted = all.filter((l) => l.groupId === "g-7b" && !l.couplingId).sort((x, y) => x.weekday - y.weekday || x.periodNr - y.periodNr);
    const a = sorted[0]!;
    const b = sorted.find((l) => l.subjectId !== a.subjectId)!;
    // Kopplung im freien Slot, eine Stunde nur im 1. Halbjahr, eine erst ab März
    const couplingId = await saveCoupling(
      h.db,
      viewer.userId,
      null,
      {
        weekday: 4,
        periodNr: 8,
        week: "all",
        validFrom: "2026-08-01",
        validUntil: "2027-07-31",
        parts: [
          { groupId: "g-7b", subjectId: a.subjectId, teacherId: null, roomId: null },
          { groupId: "g-7b", subjectId: b.subjectId, teacherId: null, roomId: null },
        ],
      },
      LIVE,
      { today, now },
    );
    await h.db.insert(timetableLessons).values([
      { id: "l-hj1", groupId: "g-7a", weekday: 4, periodNr: 8, subjectId: a.subjectId, validFrom: "2026-08-01", validUntil: "2027-01-31" },
      { id: "l-maerz", groupId: "g-7a", weekday: 4, periodNr: 8, subjectId: b.subjectId, validFrom: "2027-03-01", validUntil: "2027-07-31" },
    ]);
    await h.db.insert(timetableSubstitutions).values([
      { id: "s-hj1", lessonId: a.id, date: "2026-11-02", kind: "cancel" },
      { id: "s-hj2", lessonId: a.id, date: "2027-02-08", kind: "cancel" },
    ]);
    await h.db.insert(classbookEntries).values({ id: "k-vorher", lessonId: b.id, date: "2026-10-01", groupId: "g-7b", periodNr: b.periodNr, subjectId: b.subjectId, topic: "vorher" });
    const liveCount = (await h.db.select().from(timetableLessons)).length;

    const v = await createFromTemplate(h.db, viewer.userId, yearId, "halbjahr", today);
    expect(v).toMatchObject({ major: 2, minor: 0, status: "entwurf", source: "live_copy", validFrom: term2, name: "2. Halbjahr" });
    const draft = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, v.id));
    // alles, was ab dem 2. Halbjahr gilt (die Stunde des 1. Halbjahrs nicht), Beginn frühestens am Stichtag, Herkunft je Stunde
    expect(draft.length).toBe(liveCount - 1);
    expect(draft.some((d) => d.originLessonId === "l-hj1")).toBe(false);
    expect(draft.find((d) => d.originLessonId === "l-maerz")).toMatchObject({ validFrom: "2027-03-01" });
    expect(draft.filter((d) => d.originLessonId !== "l-maerz").every((d) => d.validFrom === term2)).toBe(true);
    // der gültige Plan bleibt bis zum Veröffentlichen unverändert (anders als „Periode kopieren“)
    expect((await h.db.select().from(timetableLessons)).length).toBe(liveCount);

    // Lauf „Lehraufträge am“: im Entwurf rechnet der Solver am Stichtag des Halbjahrs
    const runId = await createRun(h.db, viewer.userId, { seed: 1, effort: "schnell", versionId: v.id }, today);
    const [run] = await h.db.select().from(timetableSolverRuns).where(eq(timetableSolverRuns.id, runId));
    expect(run!.params).toMatchObject({ refYmd: term2, versionId: v.id });

    // im Entwurf: Stunde A bekommt einen anderen Raum
    const dA = draft.find((d) => d.originLessonId === a.id)!;
    await h.db.update(timetableDraftLessons).set({ roomId: "105" }).where(eq(timetableDraftLessons.id, dA.id));
    await submitForReview(h.db, viewer, v.id, now);
    await approveVersion(h.db, viewer, v.id, now);
    await clearPublishGate(h.db, viewer.userId, v.id, today);
    await publishVersion(h.db, viewer.userId, v.id, term2, today, now);

    const after = await h.db.select().from(timetableLessons);
    expect(after.find((l) => l.id === a.id)).toMatchObject({ validUntil: "2027-01-31" });
    const newA = after.find((l) => l.id !== a.id && l.groupId === a.groupId && l.weekday === a.weekday && l.periodNr === a.periodNr && l.validFrom === term2)!;
    expect(newA).toMatchObject({ roomId: "105", subjectId: a.subjectId, planVersionId: v.id });
    // unveränderte Stunden (B, Kopplung) behalten ihre Zeile
    expect(after.find((l) => l.id === b.id)).toMatchObject({ validUntil: b.validUntil });
    expect(after.filter((l) => l.couplingId === couplingId)).toHaveLength(2);
    // Vertretung ab dem Stichtag gehört zur neuen Stunde, die davor bleibt; Klassenbuch davor bleibt
    const subs = new Map((await h.db.select().from(timetableSubstitutions).where(and(eq(timetableSubstitutions.kind, "cancel")))).map((s) => [s.id, s.lessonId]));
    expect(subs.get("s-hj1")).toBe(a.id);
    expect(subs.get("s-hj2")).toBe(newA.id);
    expect((await h.db.select().from(classbookEntries).where(eq(classbookEntries.id, "k-vorher")))[0]!.lessonId).toBe(b.id);
    expect(after.filter((l) => l.id === "l-maerz")).toHaveLength(1);
  });
});
