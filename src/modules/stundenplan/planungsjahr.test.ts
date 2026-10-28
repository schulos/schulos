// SP3-09a (docs/STUNDENPLAN-LEBENSZYKLUS.md §3.1 „Umgesetzt (SP3-09a)“): Planen im Folgejahr. Auf der Demo-Schule mit Folgejahr nach
// Schuljahreswechsel und Versetzung: Lehraufträge, Matrix („Aus dem Vorjahr übernehmen“), Deputate und die Pflege im Entwurf landen über die
// Server Actions im gewählten Jahr, das laufende bleibt unverändert; ein abgeschlossenes Schuljahr ist nur lesbar (Actions lehnen ab).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Db, DbHandle } from "@/core/db/client";

const state = vi.hoisted(() => ({ db: null as unknown as Db, userId: "u-frank.schulte" }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/core/db/client", async (orig) => ({
  ...(await orig<typeof import("@/core/db/client")>()),
  getDb: async () => state.db,
}));
// Rechte wie bisher (`stundenplan.manage`), ohne Sitzung/2FA – hier geht es nur um das Schuljahr
vi.mock("@/core/auth/session", async (orig) => {
  const { loadPermissions, hasPermission, ForbiddenError } = await import("@/core/permissions");
  const current = async () => {
    const perms = await loadPermissions(state.db, state.userId);
    return { user: { id: state.userId, name: "", firstName: "", lastName: "", shortCode: null, role: perms.role, username: "" }, perms };
  };
  return {
    ...(await orig<typeof import("@/core/auth/session")>()),
    requireUser: current,
    getCurrentUser: current,
    requirePermission: async (p: string) => {
      const c = await current();
      if (!hasPermission(c.perms, p)) throw new ForbiddenError(p);
      return c;
    },
  };
});

import {
  auditLog,
  groups,
  schoolYears,
  schoolYearTransitions,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableDeputies,
  timetableDraftLessons,
  timetableLessons,
  timetableReductions,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { addNextSchoolYear } from "@/modules/verwaltung/school-years";
import { promote, startTransition } from "@/modules/verwaltung/schuljahreswechsel";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  addReductionAction,
  deleteAssignmentAction,
  placeAssignmentAction,
  saveAssignmentAction,
  saveBandAction,
  saveMatrixAction,
  saveObligationAction,
  saveTeacherDayRuleAction,
} from "./actions";
import { defaultValidity, plannableGroups } from "./manage";
import { loadMatrix, matrixSuggestions } from "./matrix";
import { createNewYearDraft } from "./neues-schuljahr";
import { draftOf } from "./plan-quelle";
import { requireWritableRecordYear, requireWritableYear, resolvePlanningYear, safePlanningTarget, yearOfSource, yearRole } from "./planungsjahr";
import { ensureBaseVersions } from "./planversionen";
import { writableSource } from "./quelle";
import { openAssignments } from "./setzhilfe";
import { distribution, listAssignments } from "./verteilung";

describe("Planungsjahr (rein)", () => {
  const base = { id: "b", startsOn: "2026-08-01" };
  it("Rolle gegenüber dem laufenden Schuljahr", () => {
    expect(yearRole(base, base)).toBe("laufend");
    expect(yearRole({ id: "n", startsOn: "2027-08-01" }, base)).toBe("folgejahr");
    expect(yearRole({ id: "v", startsOn: "2025-08-01" }, base)).toBe("vergangen");
  });
  it("Rücksprung nur unter /planung (keine offene Weiterleitung)", () => {
    expect(safePlanningTarget("/planung/unterricht?ansicht=matrix")).toBe("/planung/unterricht?ansicht=matrix");
    expect(safePlanningTarget("/planung")).toBe("/planung");
    expect(safePlanningTarget("/planung/versionen#vorlagen")).toBe("/planung/versionen#vorlagen");
    for (const bad of [null, "", "https://example.org/planung", "//example.org/planung", "/planungx", "/verwaltung", "/planung/../verwaltung//x", "/planung\\x", "/planung\r\nx"])
      expect(safePlanningTarget(bad)).toBe("/planung");
  });
});

describe("Planen im Folgejahr (SP3-09a, Demo-Schule)", () => {
  let h: DbHandle;
  let current: string;
  let next: string;
  const past = "sj-2025-26";
  let new8b: string;
  let ifId: string;
  const today = "2027-06-10";
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  /** Server Actions enden mit `redirect` – im Test als Fehler „REDIRECT <url>“ */
  const redirected = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      const m = /^REDIRECT (.*)$/.exec((err as Error).message);
      if (m) return m[1]!;
      throw err;
    }
    throw new Error("keine Weiterleitung");
  };
  const assignmentsOf = async (yearId: string) =>
    h.db.select().from(timetableAssignments).where(eq(timetableAssignments.schoolYearId, yearId)).orderBy(asc(timetableAssignments.id));

  beforeAll(async () => {
    h = await createSeededTestDb();
    state.db = h.db;
    current = (await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)))[0]!.id;
    await ensureBaseVersions(h.db, today);
    next = await addNextSchoolYear(h.db, "u-admin", "2027-05-01");
    await h.db.insert(schoolYears).values({ id: past, name: "2025/26", startsOn: "2025-08-01", endsOn: "2026-07-31", isCurrent: false });
    const tid = await startTransition(h.db, "u-admin", current, next);
    await promote(h.db, "u-admin", tid, { classes: [], overrides: {} });
    const [tr] = await h.db.select().from(schoolYearTransitions).where(eq(schoolYearTransitions.id, tid));
    new8b = tr!.classMap!["g-7b"]!;
  }, 120_000);
  afterAll(() => h.close());

  it("Jahreswahl: Vorgabe laufendes Schuljahr, Folgejahr wählbar, vergangene nur lesbar, Unbekanntes fällt zurück", async () => {
    const def = (await resolvePlanningYear(h.db, null))!;
    expect(def).toMatchObject({ isBase: true, role: "laufend", writable: true });
    expect(def.year.id).toBe(current);
    expect(def.choices.map((c) => [c.id, c.role, c.writable])).toEqual([
      [past, "vergangen", false],
      [current, "laufend", true],
      [next, "folgejahr", true],
    ]);
    expect(await resolvePlanningYear(h.db, next)).toMatchObject({ isBase: false, role: "folgejahr", writable: true });
    expect(await resolvePlanningYear(h.db, past)).toMatchObject({ role: "vergangen", writable: false });
    expect((await resolvePlanningYear(h.db, "gibt-es-nicht"))!.year.id).toBe(current);
    expect((await requireWritableYear(h.db, next)).id).toBe(next);
    await expect(requireWritableYear(h.db, past)).rejects.toThrow(ValidationError);
    await expect(requireWritableYear(h.db, "gibt-es-nicht")).rejects.toThrow(ValidationError);
    // Gruppen der Pflege: nur die des Schuljahrs (und ohne Schuljahr)
    const nextGroups = await plannableGroups(h.db, next);
    expect(nextGroups.some((g) => g.id === new8b)).toBe(true);
    expect(nextGroups.some((g) => g.id === "g-7b")).toBe(false);
    expect((await plannableGroups(h.db, current)).some((g) => g.id === new8b)).toBe(false);
  });

  it("Matrix im Folgejahr: „Aus dem Vorjahr übernehmen“ schlägt vor, Speichern landet im Folgejahr, das laufende bleibt unverändert", async () => {
    const before = await assignmentsOf(current);
    const nextYear = (await resolvePlanningYear(h.db, next))!.year;
    const d = await distribution(h.db, nextYear, today);
    expect(d.refYmd).toBe(nextYear.startsOn);
    const matrix = await loadMatrix(h.db, d, 8);
    expect(matrix.rows.some((r) => r.groupId === new8b)).toBe(true);
    const res = await matrixSuggestions(h.db, nextYear, d.refYmd, matrix, "vorjahr");
    expect(res.missing).toBeUndefined();
    const for8b = res.suggestions.filter((s) => s.groupId === new8b);
    expect(for8b.length).toBeGreaterThan(0);

    const edits = for8b.map((s) => ({ groupId: s.groupId, subjectId: s.subjectId, assignmentId: null, teacherId: s.teacherId, hours: s.hours, offSubjectOk: s.teacherId }));
    const saved = await saveMatrixAction(next, edits, d.refYmd, "vorjahr");
    expect(saved.error).toBeUndefined();
    expect(saved.results.every((r) => r.ok)).toBe(true);
    const created = await listAssignments(h.db, next);
    expect(created).toHaveLength(edits.length);
    expect(created.every((a) => a.groups[0]?.id === new8b)).toBe(true);
    expect(await assignmentsOf(current)).toEqual(before);
    // Audit nennt das Jahr
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.assignment.matrix")).orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    expect(a!.meta).toMatchObject({ source: "vorjahr", year: next, created: edits.length });
  });

  it("Lehrauftrag und Band im Folgejahr; Klasse des laufenden Jahres dort abgelehnt, Wechsel des Schuljahrs beim Ändern auch", async () => {
    const before = await assignmentsOf(current);
    const url = await redirected(saveAssignmentAction(next, null, {}, form({ groupId: new8b, subjectId: "IF", hours: "2", back: "/planung/unterricht" })));
    expect(url).toBe("/planung/unterricht");
    const [mine] = (await listAssignments(h.db, next)).filter((a) => a.subjectId === "IF" && a.teachers.length === 0);
    expect(mine).toMatchObject({ hours: 2, groups: [{ id: new8b }] });
    ifId = mine!.id;
    const logs = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "stundenplan.assignment.create"), eq(auditLog.target, new8b)))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    expect(logs.map((l) => l.meta)).toContainEqual(expect.objectContaining({ subject: "IF", year: next }));

    // eine Klasse des laufenden Jahrs gehört nicht ins Folgejahr
    const wrong = await saveAssignmentAction(next, null, {}, form({ groupId: "g-7b", subjectId: "IF", hours: "2" }));
    expect(wrong).toMatchObject({ error: expect.stringMatching(/anderen Schuljahr/) });
    // ein Lehrauftrag bleibt in seinem Schuljahr
    const [cur] = before;
    const [curGroup] = await h.db.select().from(timetableAssignmentGroups).where(eq(timetableAssignmentGroups.assignmentId, cur!.id));
    const moved = await saveAssignmentAction(next, cur!.id, {}, form({ groupId: curGroup!.groupId, subjectId: cur!.subjectId, hours: String(cur!.hours) }));
    expect(moved).toMatchObject({ error: expect.stringMatching(/anderen Schuljahr/) });

    const band = await redirected(saveBandAction(next, null, {}, form({ name: "Religion/Philosophie 8", hours: "2" })));
    expect(band).toMatch(/ansicht=baender&band=/);
    expect(await assignmentsOf(current)).toEqual(before);
  });

  it("Deputat, Tagesregel und Anrechnung im Folgejahr; das laufende Jahr bleibt, Audit mit Jahr", async () => {
    const teacher = "u-jana.brandt";
    const curDeputy = await h.db.select().from(timetableDeputies).where(eq(timetableDeputies.schoolYearId, current)).orderBy(asc(timetableDeputies.teacherId));
    expect(await saveObligationAction(next, teacher, {}, form({ obligation: "20" }))).toEqual({ ok: true });
    expect(await saveTeacherDayRuleAction(next, teacher, {}, form({ maxPerDay: "6" }))).toEqual({ ok: true });
    expect(await addReductionAction(next, teacher, {}, form({ reason: "schulleitung", hours: "2" }))).toEqual({ ok: true });
    const [dep] = await h.db.select().from(timetableDeputies).where(and(eq(timetableDeputies.schoolYearId, next), eq(timetableDeputies.teacherId, teacher)));
    expect(dep).toMatchObject({ obligation: 20 });
    expect(await h.db.select().from(timetableReductions).where(and(eq(timetableReductions.schoolYearId, next), eq(timetableReductions.teacherId, teacher)))).toHaveLength(1);
    expect(await h.db.select().from(timetableDeputies).where(eq(timetableDeputies.schoolYearId, current)).orderBy(asc(timetableDeputies.teacherId))).toEqual(curDeputy);
    const [log] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "stundenplan.deputy.obligation"), eq(auditLog.target, teacher)));
    expect(log!.meta).toMatchObject({ obligation: 20, year: next });
  });

  it("Pflege im Entwurf des Folgejahrs: Setzhilfe mit den Lehraufträgen des Folgejahrs, Gültigkeit bis zu dessen Ende, gültiger Plan unverändert", async () => {
    const live = await h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id));
    const draft = await createNewYearDraft(h.db, state.userId, next, "leer", today);
    expect((await yearOfSource(h.db, draftOf(draft.id)))!.id).toBe(next);
    expect(await writableSource(h.db, draft.id)).toEqual(draftOf(draft.id));
    expect(await defaultValidity(h.db, today, draft.validFrom!)).toEqual({ validFrom: draft.validFrom, validUntil: "2028-07-31" });

    const open = await openAssignments(h.db, new8b, draft.validFrom!, draftOf(draft.id));
    const ia = open.find((a) => a.id === ifId);
    expect(ia).toMatchObject({ open: 2 });
    const url = await redirected(placeAssignmentAction(ia!.id, new8b, null, draft.id, 0, 1));
    expect(url).not.toMatch(/fehler=/);
    const rows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, draft.id)).orderBy(asc(timetableDraftLessons.id));
    expect(rows).toEqual([expect.objectContaining({ groupId: new8b, subjectId: "IF", weekday: 0, periodNr: 1, assignmentId: ia!.id, validFrom: draft.validFrom, validUntil: "2028-07-31" })]);
    expect(await h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id))).toEqual(live);
  });

  it("abgeschlossenes Schuljahr nur lesbar: Actions lehnen ab, Datensätze darin lassen sich nicht löschen", async () => {
    const [g] = await h.db.insert(groups).values({ name: "6a (alt)", slug: "6a-alt", kind: "klasse", schoolYearId: past, gradeLevel: 6 }).returning();
    expect(await saveAssignmentAction(past, null, {}, form({ groupId: g!.id, subjectId: "D", hours: "4" }))).toMatchObject({ error: expect.stringMatching(/2025\/26 ist abgeschlossen/) });
    expect(await saveMatrixAction(past, [{ groupId: g!.id, subjectId: "D", assignmentId: null, teacherId: null, hours: 4 }], "2026-03-01", "matrix")).toMatchObject({
      results: [],
      error: expect.stringMatching(/abgeschlossen/),
    });
    expect(await saveObligationAction(past, "u-jana.brandt", {}, form({ obligation: "20" }))).toMatchObject({ error: expect.stringMatching(/abgeschlossen/) });
    expect(await addReductionAction(past, "u-jana.brandt", {}, form({ reason: "schulleitung", hours: "1" }))).toMatchObject({ error: expect.stringMatching(/abgeschlossen/) });
    expect(await saveBandAction(past, null, {}, form({ name: "Alt", hours: "2" }))).toMatchObject({ error: expect.stringMatching(/abgeschlossen/) });
    expect(await h.db.select().from(timetableAssignments).where(eq(timetableAssignments.schoolYearId, past))).toEqual([]);

    const [old] = await h.db.insert(timetableAssignments).values({ schoolYearId: past, subjectId: "D", hours: 4 }).returning();
    await expect(requireWritableRecordYear(h.db, "assignment", old!.id)).rejects.toThrow(ValidationError);
    await expect(deleteAssignmentAction(old!.id, "/planung/unterricht")).rejects.toMatchObject({ fieldErrors: { schoolYearId: expect.stringMatching(/abgeschlossen/) } });
    expect(await h.db.select().from(timetableAssignments).where(eq(timetableAssignments.id, old!.id))).toHaveLength(1);
    // laufendes Jahr: unverändert schreibbar (Gegentest)
    expect(await requireWritableRecordYear(h.db, "assignment", (await assignmentsOf(current))[0]!.id)).toMatchObject({ id: current });
  });
});
