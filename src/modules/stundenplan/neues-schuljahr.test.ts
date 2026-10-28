// SP3-07 (docs/STUNDENPLAN-LEBENSZYKLUS.md §4 Vorlagen, §7.2): Vorlage „Neues Schuljahr“ – Hochstufen rein und auf der Demo-Schule
// (Schuljahreswechsel → Versetzung → Entwurf aus dem Vorjahr), Namensregel ohne `class_map`, leerer Entwurf, Veröffentlichen ins neue Jahr.
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, groups, schoolYears, schoolYearTransitions, timetableDraftLessons, timetableLessons, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { addNextSchoolYear } from "@/modules/verwaltung/school-years";
import { promote, startTransition } from "@/modules/verwaltung/schuljahreswechsel";
import { ValidationError } from "@/modules/verwaltung/users";
import { createNewYearDraft, newYearTemplate, promoteLessons, type PreviousLesson } from "./neues-schuljahr";
import { approveVersion, submitForReview, type Viewer } from "./planpruefung";
import { ensureBaseVersions, listVersions, validVersion } from "./planversionen";
import { lessonActiveOn } from "./service";
import { publishVersion } from "./veroeffentlichen";
import { templateOf } from "./fahrplan";
import { clearPublishGate } from "./fahrplan.testing";

const lesson = (over: Partial<PreviousLesson>): PreviousLesson => ({
  id: "l",
  groupId: "g-7a",
  weekday: 0,
  periodNr: 1,
  subjectId: "M",
  teacherId: "t-1",
  roomId: "101",
  week: "all",
  couplingId: null,
  fixed: false,
  ...over,
});

describe("promoteLessons (rein, SP3-07)", () => {
  const opts = {
    classMap: new Map([
      ["g-7a", "g-8a"],
      ["g-7b", "g-8b"],
    ]),
    classIds: new Set(["g-7a", "g-7b", "g-10a"]),
    activeTeachers: new Set(["t-1"]),
    validFrom: "2027-08-02",
  };

  it("Klassen gehen an die Nachfolgeklasse; Tag, Stunde, Woche, Fach, Raum, Fixierung und aktive Lehrkraft bleiben", () => {
    const r = promoteLessons([lesson({ week: "B", fixed: true, roomId: "105" }), lesson({ id: "l2", groupId: "g-7b", teacherId: null })], opts);
    expect(r.rows).toEqual([
      {
        groupId: "g-8a",
        weekday: 0,
        periodNr: 1,
        subjectId: "M",
        teacherId: "t-1",
        roomId: "105",
        week: "B",
        validFrom: "2027-08-02",
        validUntil: null,
        couplingId: null,
        fixed: true,
        solverRunId: null,
        originLessonId: null,
        assignmentId: null,
      },
      expect.objectContaining({ groupId: "g-8b", teacherId: null }),
    ]);
    expect(r.skipped).toEqual({ courses: 0, coupled: 0, unmapped: 0 });
    expect(r.teacherCleared).toBe(0);
  });

  it("Kurse/andere Gruppen, gekoppelte Stunden (Bänder) und Klassen ohne eindeutige Nachfolgeklasse kommen nicht mit", () => {
    const r = promoteLessons(
      [lesson({ groupId: "k-ef-m1" }), lesson({ couplingId: "c-1" }), lesson({ groupId: "g-10a" }), lesson({ teacherId: "t-weg" }), lesson({ groupId: "g-7b" })],
      opts,
    );
    expect(r.skipped).toEqual({ courses: 1, coupled: 1, unmapped: 1 });
    // nicht mehr aktive Lehrkraft: Stunde bleibt, Lehrkraft offen
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ groupId: "g-8a", teacherId: null });
    expect(r.teacherCleared).toBe(1);
  });
});

describe("Vorlage „Neues Schuljahr“ (SP3-07, Demo-Schule)", () => {
  let h: DbHandle;
  let fromId: string;
  let toId: string;
  const today = "2027-06-10";
  const now = new Date("2027-06-10T08:00:00Z");
  const viewer: Viewer = { userId: "u-frank.schulte", manage: true, review: true };
  const year = async (id: string) => (await h.db.select().from(schoolYears).where(eq(schoolYears.id, id)))[0]!;

  beforeAll(async () => {
    h = await createSeededTestDb();
    fromId = (await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)))[0]!.id;
    await ensureBaseVersions(h.db, today);
    toId = await addNextSchoolYear(h.db, "u-admin", "2027-05-01");
  }, 120_000);
  afterAll(() => h.close());

  it("ohne Versetzung kein Entwurf: Schritte zeigen, was fehlt (mit Sprungziel Schuljahreswechsel)", async () => {
    const t = await newYearTemplate(h.db, await year(toId), today, fromId);
    expect(t.previousYear?.id).toBe(fromId);
    expect(t.planningYear).toBe(false);
    expect(t.steps.map((s) => [s.key, s.done])).toEqual([
      ["jahr", true],
      ["wechsel", false],
      ["versetzung", false],
      ["entwurf", false],
    ]);
    expect(t.steps.find((s) => s.key === "versetzung")!.href).toBe("/verwaltung/schuljahreswechsel");
    expect(t.offer).toMatchObject({ ok: false, reason: expect.stringMatching(/Versetzung/) });
    expect(t.preview).toBeNull();
    await expect(createNewYearDraft(h.db, viewer.userId, toId, "vorjahr", today)).rejects.toBeInstanceOf(ValidationError);
    // das erste Schuljahr hat kein Vorjahr
    expect((await newYearTemplate(h.db, await year(fromId), today)).offer).toMatchObject({ ok: false, reason: expect.stringMatching(/kein Schuljahr/) });
  });

  it("nach der Versetzung: Entwurf 1.0 ab dem ersten Schultag, Plan des Vorjahrs hochgestuft (class_map), Lehrkraft folgt der Klasse", async () => {
    const tid = await startTransition(h.db, "u-admin", fromId, toId);
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    const [tr] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    const new8b = tr!.classMap!["g-7b"]!;

    const t = await newYearTemplate(h.db, await year(toId), today, fromId);
    expect(t.steps.every((s) => s.done || s.key === "entwurf")).toBe(true);
    expect(t.offer).toEqual({ ok: true, validFrom: "2027-08-02", number: "1.0", name: `Schuljahr ${(await year(toId)).name}` });
    expect(t.preview).toMatchObject({ reconstructed: false, reference: "2027-07-30" });
    expect(t.preview!.lessons).toBeGreaterThan(0);
    // 10a + 10b laufen in der EF zusammen → ihre Stunden haben keine eindeutige Nachfolgeklasse
    expect(t.preview!.skipped.unmapped).toBeGreaterThan(0);
    expect(t.assignmentSuggestions).toBeGreaterThan(0);

    const v = await createNewYearDraft(h.db, viewer.userId, toId, "vorjahr", today);
    // SP3-08: die Versionsliste setzt denselben Vorlagen-Vermerk wie der Planungsfahrplan – der Fahrplan erkennt den Entwurf als „Neues Schuljahr“
    expect(v.checklist).toMatchObject({ template: "schuljahr" });
    expect(templateOf(v, v.checklist as never)).toBe("schuljahr");
    const base = (await validVersion(h.db, fromId))!;
    expect(v).toMatchObject({ schoolYearId: toId, major: 1, minor: 0, status: "entwurf", source: "previous_version", parentVersionId: base.id, validFrom: "2027-08-02" });
    const rows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, v.id)).orderBy(asc(timetableDraftLessons.id));
    expect(rows).toHaveLength(t.preview!.lessons);
    const newClasses = new Set((await h.db.select({ id: groups.id }).from(groups).where(and(eq(groups.schoolYearId, toId), eq(groups.kind, "klasse")))).map((g) => g.id));
    expect(rows.every((r) => newClasses.has(r.groupId) && r.couplingId === null && r.originLessonId === null && r.validFrom === "2027-08-02" && r.validUntil === null)).toBe(true);
    // 7b → 8b: dieselben ungekoppelten Stunden (Tag, Stunde, Fach, Lehrkraft, Raum) wie am letzten Schultag
    const old7b = (await h.db.select().from(timetableLessons).where(eq(timetableLessons.groupId, "g-7b"))).filter((l) => !l.couplingId && l.validFrom <= "2027-07-30" && (l.validUntil === null || l.validUntil >= "2027-07-30"));
    const key = (l: { weekday: number; periodNr: number; subjectId: string; teacherId: string | null; roomId: string | null; week: string }) =>
      `${l.weekday}|${l.periodNr}|${l.subjectId}|${l.teacherId}|${l.roomId}|${l.week}`;
    expect(rows.filter((r) => r.groupId === new8b).map(key).sort()).toEqual(old7b.map(key).sort());

    // Liste: Herkunft aus dem Vorjahr; Schritt „Entwurf“ erledigt; Audit mit Zahlen ohne Personen
    const s = (await listVersions(h.db, toId, today)).find((x) => x.version.id === v.id)!;
    expect(s).toMatchObject({ parentLabel: "1.0", parentYearName: (await year(fromId)).name });
    expect((await newYearTemplate(h.db, await year(toId), today)).steps.find((x) => x.key === "entwurf")!.done).toBe(true);
    const [a] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "stundenplan.plan.create"), eq(auditLog.target, v.id)));
    expect(a!.meta).toMatchObject({ template: "schuljahr", lessons: rows.length, reconstructed: false });
    const names = (await h.db.select({ name: users.name }).from(users)).map((u) => u.name);
    expect(names.some((n) => JSON.stringify(a!.meta).includes(n))).toBe(false);
  });

  it("ohne class_map (Übergang vor SP3-LA) über die Namensregel; leerer Entwurf geht immer", async () => {
    const before = (await newYearTemplate(h.db, await year(toId), today)).preview!;
    await h.db.update(schoolYearTransitions).set({ classMap: null }).where(eq(schoolYearTransitions.fromYearId, fromId));
    const rec = (await newYearTemplate(h.db, await year(toId), today)).preview!;
    expect(rec.reconstructed).toBe(true);
    expect(rec.lessons).toBe(before.lessons);
    const empty = await createNewYearDraft(h.db, viewer.userId, toId, "leer", today);
    expect(empty).toMatchObject({ major: 2, minor: 0, source: "empty", parentVersionId: null });
    expect(empty.checklist).toMatchObject({ template: "schuljahr" });
    expect(await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, empty.id))).toEqual([]);
  });

  it("veröffentlicht gilt im neuen Schuljahr nur der hochgestufte Plan; danach bietet die Vorlage nichts mehr an", async () => {
    const v = (await listVersions(h.db, toId, today)).find((x) => x.version.source === "previous_version")!.version;
    await submitForReview(h.db, viewer, v.id, now);
    await approveVersion(h.db, viewer, v.id, now);
    await clearPublishGate(h.db, viewer.userId, v.id, today); // SP3-06: Schritt 7 des Fahrplans
    await publishVersion(h.db, viewer.userId, v.id, "2027-08-02", today, now);
    const live = await h.db.select().from(timetableLessons);
    const onDay = live.filter((l) => lessonActiveOn(l, "2027-08-02"));
    const newClasses = new Set((await h.db.select({ id: groups.id }).from(groups).where(eq(groups.schoolYearId, toId))).map((g) => g.id));
    expect(onDay.length).toBeGreaterThan(0);
    // unbefristete Stunden des Vorjahrs enden am Vortag, Stunden des Vorjahrs gelten am letzten Schultag weiter
    expect(onDay.every((l) => newClasses.has(l.groupId))).toBe(true);
    expect(live.filter((l) => lessonActiveOn(l, "2027-07-30") && newClasses.has(l.groupId))).toEqual([]);
    expect((await newYearTemplate(h.db, await year(toId), today)).offer).toMatchObject({ ok: false, reason: expect.stringMatching(/gilt schon ein Plan/) });
  }, 60_000);
});
