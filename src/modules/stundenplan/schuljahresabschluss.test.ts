// SP3-07 (docs/STUNDENPLAN-LEBENSZYKLUS.md §7.2): Schuljahresabschluss – Kurzstatistik Ausfall/Vertretung (rein und auf der Demo-Schule,
// ohne Namen auch für die Prüfung) und „Schuljahr archivieren“ (erst nach dem Ende, nur Planung, alles bleibt lesbar).
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, groups, schoolYears, timetableLessons, timetablePlanVersions, timetableSubstitutions, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { publishedTimeline, versionOn } from "./plan-archiv";
import { cleanupVersions, createDraft, ensureBaseVersions, listVersions, validVersion } from "./planversionen";
import {
  archiveYear,
  plannedLessons,
  share,
  summarizeSubstitutions,
  yearArchiveState,
  yearClosing,
  yearStatistics,
  type ClosingViewer as Viewer,
  type SubstitutionStatRow,
} from "./schuljahresabschluss";

describe("Kurzstatistik (rein, SP3-07)", () => {
  const row = (date: string, kind: SubstitutionStatRow["kind"], reason: SubstitutionStatRow["reason"] = null, supervisionOnly = false): SubstitutionStatRow => ({ date, kind, reason, supervisionOnly });

  it("zählt je Art, Grund-Kategorie und Monat; außerhalb des Zeitraums nicht", () => {
    const s = summarizeSubstitutions(
      [
        row("2026-09-01", "cancel", "lehrkraft_abwesend"),
        row("2026-09-02", "substitute", "lehrkraft_abwesend", true),
        row("2026-09-03", "substitute", "klassenfahrt"),
        row("2026-10-01", "merge", "lehrkraft_abwesend"),
        row("2026-10-02", "move"),
        row("2026-10-05", "room", "raum_gesperrt"),
        row("2026-07-31", "cancel"),
        row("2027-08-01", "cancel"),
      ],
      200,
      "2026-08-01",
      "2027-07-31",
    );
    expect(s).toMatchObject({ planned: 200, cancel: 1, substitute: 2, supervision: 1, merge: 1, move: 1, room: 1 });
    expect(s.byReason).toEqual([
      { reason: "lehrkraft_abwesend", label: "Lehrkraft abwesend", count: 3 },
      { reason: "klassenfahrt", label: "Klassenfahrt", count: 1 },
      { reason: "raum_gesperrt", label: "Raum gesperrt", count: 1 },
      { reason: null, label: "ohne Angabe", count: 1 },
    ]);
    expect(s.byMonth).toEqual([
      { month: "2026-09", label: "September 2026", cancel: 1, substitute: 2, other: 0 },
      { month: "2026-10", label: "Oktober 2026", cancel: 0, substitute: 1, other: 2 },
    ]);
    expect(share(1, 200)).toBe(0.5);
    expect(share(1, 0)).toBeNull();
  });

  it("Stunden laut Plan: je Schultag die Stunden, die an dem Tag gelten (A/B-Woche, Gültigkeit)", () => {
    const lessons = [
      { weekday: 0, week: "all", validFrom: "2026-08-01", validUntil: null },
      { weekday: 0, week: "A", validFrom: "2026-08-01", validUntil: null },
      { weekday: 1, week: "all", validFrom: "2026-09-08", validUntil: null },
    ];
    // Mo 31.08. (KW 36, B), Di 01.09., Mo 07.09. (KW 37, A), Di 08.09.
    expect(plannedLessons(lessons, ["2026-08-31", "2026-09-01", "2026-09-07", "2026-09-08"])).toBe(1 + 0 + 2 + 1);
  });
});

describe("Schuljahresabschluss (SP3-07, Demo-Schule)", () => {
  let h: DbHandle;
  let yearId: string;
  const today = "2026-10-05";
  const after = "2027-08-10";
  const manage: Viewer = { userId: "u-frank.schulte", manage: true, review: false };
  const review: Viewer = { userId: "u-petra.lindner", manage: false, review: true };
  const year = async () => (await h.db.select().from(schoolYears).where(eq(schoolYears.id, yearId)))[0]!;

  beforeAll(async () => {
    h = await createSeededTestDb();
    // der Seed legt „Bestand 1.0“ mit dem echten Datum an – hier mit festem „heute“ neu
    await h.db.update(timetableLessons).set({ planVersionId: null });
    await h.db.delete(timetablePlanVersions);
    await ensureBaseVersions(h.db, today);
    yearId = (await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)))[0]!.id;
  }, 120_000);
  afterAll(() => h.close());

  it("Kurzstatistik bis heute, nur Zahlen – die Prüfung sieht sie ohne Namen, ohne Recht gibt es nichts", async () => {
    const lessons = await h.db.select().from(timetableLessons).where(eq(timetableLessons.groupId, "g-7b")).orderBy(asc(timetableLessons.id));
    const before = (await yearStatistics(h.db, await year(), today))!;
    await h.db.insert(timetableSubstitutions).values([
      { lessonId: lessons[0]!.id, date: "2026-09-14", kind: "cancel", reason: "lehrkraft_abwesend" },
      { lessonId: lessons[1]!.id, date: "2026-09-15", kind: "substitute", substituteId: "u-jana.brandt", reason: "lehrkraft_abwesend", supervisionOnly: true },
      { lessonId: lessons[2]!.id, date: "2026-10-01", kind: "room", reason: "raum_gesperrt" },
      // nach „heute“: zählt (noch) nicht
      { lessonId: lessons[3]!.id, date: "2026-11-02", kind: "cancel", reason: "klassenfahrt" },
    ]);
    const stats = (await yearStatistics(h.db, await year(), today))!;
    expect(stats).toMatchObject({ from: "2026-08-01", to: today });
    expect(stats.planned).toBeGreaterThan(1000);
    expect([stats.cancel - before.cancel, stats.substitute - before.substitute, stats.supervision - before.supervision, stats.room - before.room]).toEqual([1, 1, 1, 1]);

    const seen = await yearClosing(h.db, review, await year(), today);
    expect(seen.stats).toEqual(stats);
    expect(seen.canArchive).toBe(false);
    const people = await h.db.select({ id: users.id, name: users.name, code: users.shortCode }).from(users);
    const groupNames = (await h.db.select({ name: groups.name }).from(groups)).map((g) => g.name);
    const text = JSON.stringify(seen);
    expect(people.filter((p) => text.includes(p.id) || text.includes(p.name) || (p.code && text.includes(`"${p.code}"`)))).toEqual([]);
    expect(groupNames.filter((n) => text.includes(n))).toEqual([]);
    await expect(yearClosing(h.db, { userId: "u-lea.schaefer", manage: false, review: false }, await year(), today)).rejects.toBeInstanceOf(ForbiddenError);
    // vor Schuljahresbeginn keine Statistik
    expect(await yearStatistics(h.db, await year(), "2026-07-15")).toBeNull();
  });

  it("archivieren erst nach dem Ende und nur mit `manage`; danach archiviert, offene Entwürfe verworfen, alles lesbar", async () => {
    const draft = await createDraft(h.db, manage.userId, { schoolYearId: yearId, source: "live_copy", validFrom: "2026-11-02", numbering: "minor" }, today);
    const valid = (await validVersion(h.db, yearId))!;
    await expect(archiveYear(h.db, manage, yearId, today)).rejects.toMatchObject({ fieldErrors: { year: expect.stringMatching(/erst nach dem Schuljahresende/) } });
    await expect(archiveYear(h.db, review, yearId, after)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await yearArchiveState(h.db, await year(), after)).toEqual({ ended: true, valid: { id: valid.id, label: "1.0", name: "Bestand" }, open: 1, archived: false });
    expect((await yearClosing(h.db, manage, await year(), after)).canArchive).toBe(true);
    const lessonsBefore = await h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id));

    const res = await archiveYear(h.db, manage, yearId, after, new Date("2027-08-10T08:00:00Z"));
    expect(res.discarded).toBe(1);
    expect(res.archived).toMatchObject({ id: valid.id, status: "archiviert", validUntil: "2027-07-31", undo: null });
    const [d] = await h.db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, draft.id));
    expect(d).toMatchObject({ status: "verworfen", discardedBy: manage.userId });
    expect(await yearArchiveState(h.db, await year(), after)).toMatchObject({ archived: true, valid: null, open: 0 });
    expect((await yearClosing(h.db, manage, await year(), after)).canArchive).toBe(false);
    await expect(archiveYear(h.db, manage, yearId, after)).rejects.toBeInstanceOf(ValidationError);

    // lesbar: der Plan selbst unverändert, „Plan am Tag X“, Zeitstrahl, Versionsliste; Nachtjob und „Bestand“ legen nichts nach
    expect(await h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id))).toEqual(lessonsBefore);
    expect(await versionOn(h.db, "2027-03-01")).toMatchObject({ id: valid.id, status: "archiviert" });
    expect((await publishedTimeline(h.db, yearId)).map((t) => [t.label, t.status])).toEqual([["1.0", "archiviert"]]);
    expect((await listVersions(h.db, yearId, after)).map((s) => s.version.status).sort()).toEqual(["archiviert", "verworfen"]);
    expect(await ensureBaseVersions(h.db, after)).toBe(0);
    await cleanupVersions(h.db, new Date("2027-08-11T01:00:00Z"));
    expect((await h.db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.schoolYearId, yearId))).map((v) => v.status).sort()).toEqual(["archiviert", "verworfen"]);
    // die Kurzstatistik bleibt (bis Schuljahresende)
    expect((await yearStatistics(h.db, await year(), after))!.to).toBe("2027-07-31");

    const [a] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "stundenplan.plan.archive_year")));
    expect(a).toMatchObject({ actorId: manage.userId, target: valid.id, meta: { year: (await year()).name, version: "1.0", discarded: 1 } });
  });
});
