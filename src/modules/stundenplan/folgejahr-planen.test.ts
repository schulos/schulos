// SP3-09b (docs/STUNDENPLAN-LEBENSZYKLUS.md §3.1 „Umgesetzt (SP3-09b)“): Planen im Folgejahr, Teil b. Auf der Demo-Schule mit Folgejahr nach
// Schuljahreswechsel und Versetzung: Zeitwünsche und Eingabefenster je Schuljahr, „Automatisch planen“ im Entwurf des Folgejahrs (Lauf, Übernahme,
// Warmstart), Fahrplan/Diagnose, Exporte und das Veröffentlichen ab dem ersten Schultag des Folgejahrs – das laufende Schuljahr bleibt
// unverändert, ein abgeschlossenes ist nur lesbar.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
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

import { auditLog, groups, schoolYears, schoolYearTransitions, timetableAssignments, timetableDraftLessons, timetableLessons, timetableTimePrefs } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { addNextSchoolYear } from "@/modules/verwaltung/school-years";
import { promote, startTransition } from "@/modules/verwaltung/schuljahreswechsel";
import { ValidationError } from "@/modules/verwaltung/users";
import { savePrefsAction, saveMatrixAction, setPrefWindowAction } from "./actions";
import { buildExport } from "./exporte";
import { loadFahrplan } from "./fahrplan";
import { clearPublishGate } from "./fahrplan.testing";
import { loadMatrix, matrixSuggestions } from "./matrix";
import { createNewYearDraft } from "./neues-schuljahr";
import { approveVersion, submitForReview, type Viewer } from "./planpruefung";
import { resolvePlanningYear } from "./planungsjahr";
import { createDraft, ensureBaseVersions, getVersion } from "./planversionen";
import { lessonActiveOn } from "./service";
import { applyRunToDraft, createRun, executeRun, getRun, proposedLessons } from "./solverlauf";
import { publishVersion } from "./veroeffentlichen";
import { distribution } from "./verteilung";
import { allPrefs, prefKey } from "./zeitwuensche";
import { openWindow, ownPrefYear, readPrefWindow, saveOwnPrefs, submissions } from "./zeitwunsch-fenster";

describe("Planen im Folgejahr, Teil b (SP3-09b, Demo-Schule)", () => {
  let h: DbHandle;
  let current: string;
  let next: string;
  const past = "sj-2025-26";
  let new8b: string;
  let nextGroups: Set<string>;
  let draftId: string;
  let runId: string;
  let warmId: string;
  const today = "2027-06-10";
  const now = new Date("2027-06-10T08:00:00Z");
  const viewer: Viewer = { userId: "u-frank.schulte", manage: true, review: true };
  /** gesperrt für die neue 8b im Folgejahr: Montag 1. bis 3. Stunde */
  const BLOCKED = [prefKey(0, 1), prefKey(0, 2), prefKey(0, 3)];
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const liveRows = () => h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id));
  const assignmentRows = (yearId: string) => h.db.select().from(timetableAssignments).where(eq(timetableAssignments.schoolYearId, yearId)).orderBy(asc(timetableAssignments.id));
  const prefRows = (yearId: string) => h.db.select().from(timetableTimePrefs).where(eq(timetableTimePrefs.schoolYearId, yearId)).orderBy(asc(timetableTimePrefs.id));

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
    nextGroups = new Set((await h.db.select({ id: groups.id }).from(groups).where(eq(groups.schoolYearId, next))).map((g) => g.id));
    // Lehraufträge der neuen 8b aus dem Vorjahr (Matrix), dann der leere Entwurf „Neues Schuljahr“
    const nextYear = (await resolvePlanningYear(h.db, next))!.year;
    const d = await distribution(h.db, nextYear, today);
    const res = await matrixSuggestions(h.db, nextYear, d.refYmd, await loadMatrix(h.db, d, 8), "vorjahr");
    const edits = res.suggestions
      .filter((s) => s.groupId === new8b)
      .map((s) => ({ groupId: s.groupId, subjectId: s.subjectId, assignmentId: null, teacherId: s.teacherId, hours: s.hours, offSubjectOk: s.teacherId }));
    const saved = await saveMatrixAction(next, edits, d.refYmd, "vorjahr");
    expect(saved.results.every((r) => r.ok)).toBe(true);
    draftId = (await createNewYearDraft(h.db, state.userId, next, "leer", today)).id;
  }, 180_000);
  afterAll(() => h.close());

  it("Zeitwünsche je Schuljahr: Fenster fürs Folgejahr, Lehrkraft gibt fürs Folgejahr ab, Planung sperrt dort; laufendes Jahr unverändert, vergangenes nur lesbar", async () => {
    const curPrefs = await prefRows(current);
    const curPrefsMap = await allPrefs(h.db);

    // Fenster fürs Folgejahr (Planungsjahr der Seite, gebunden)
    expect(await setPrefWindowAction(next, {}, form({ opensOn: "2027-06-01", closesOn: "2027-06-30" }))).toEqual({ ok: true });
    expect(await readPrefWindow(h.db)).toMatchObject({ schoolYearId: next });
    expect(await openWindow(h.db, today)).toMatchObject({ schoolYearId: next });
    // „Meine Zeitwünsche“ sagt, für welches Schuljahr
    const own = await ownPrefYear(h.db, today);
    expect(own).toMatchObject({ state: "open", year: { id: next, name: "2027/28" } });

    // Lehrkraft gibt im offenen Fenster ab – landet im Folgejahr
    const jana = await loadPermissions(h.db, "u-jana.brandt");
    expect(await saveOwnPrefs(h.db, jana, new Map([[prefKey(4, 6), -2]]), today)).toBe(1);
    const nextPrefs = await allPrefs(h.db, next);
    expect(nextPrefs.get("teacher:u-jana.brandt")?.get(prefKey(4, 6))).toBe(-2);
    expect((await submissions(h.db, next)).has("u-jana.brandt")).toBe(true);
    expect((await submissions(h.db)).has("u-jana.brandt")).toBe(false);

    // Planung sperrt Zeiten der neuen 8b im Folgejahr; eine Klasse des laufenden Jahrs gehört nicht dorthin
    const grid = Object.fromEntries(BLOCKED.map((k) => [`c-${k}`, "x"]));
    expect(await savePrefsAction(next, "group", new8b, {}, form(grid))).toEqual({ ok: true });
    expect(await savePrefsAction(next, "group", "g-7b", {}, form(grid))).toMatchObject({ error: expect.stringMatching(/wählen/) });
    expect(await savePrefsAction(past, "teacher", "u-jana.brandt", {}, form(grid))).toMatchObject({ error: expect.stringMatching(/2025\/26 ist abgeschlossen/) });
    expect([...((await allPrefs(h.db, next)).get(`group:${new8b}`) ?? new Map()).entries()]).toEqual(BLOCKED.map((k) => [k, null]));
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.timepref.save")).orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    expect(log!.meta).toMatchObject({ year: next });

    // laufendes Schuljahr unverändert
    expect(await prefRows(current)).toEqual(curPrefs);
    expect(await allPrefs(h.db)).toEqual(curPrefsMap);
    // ein abgeschlossenes Schuljahr bekommt kein Fenster
    await expect(setPrefWindowAction(past, {}, form({ opensOn: "2027-06-01", closesOn: "2027-06-30" }))).resolves.toMatchObject({ error: expect.stringMatching(/abgeschlossen/) });
    expect(await readPrefWindow(h.db)).toMatchObject({ schoolYearId: next });
  });

  it("Automatisch planen im Entwurf des Folgejahrs: nur im Entwurf, Sperrzeiten des Folgejahrs, Übernahme in den Entwurf, Warmstart; gültiger Plan und laufendes Jahr unverändert", async () => {
    const live = await liveRows();
    const curAssignments = await assignmentRows(current);

    // außerhalb des laufenden Schuljahrs nur im Entwurf; abgeschlossene Jahre nie; Entwurf und Seite müssen zusammenpassen
    await expect(createRun(h.db, state.userId, { seed: 1, effort: "schnell", schoolYearId: next }, today)).rejects.toMatchObject({ fieldErrors: { versionId: expect.stringMatching(/nur in einem Entwurf/) } });
    await expect(createRun(h.db, state.userId, { seed: 1, effort: "schnell", schoolYearId: past }, today)).rejects.toMatchObject({ fieldErrors: { schoolYearId: expect.stringMatching(/abgeschlossen/) } });
    await expect(createRun(h.db, state.userId, { seed: 1, effort: "schnell", versionId: draftId, schoolYearId: current }, today)).rejects.toBeInstanceOf(ValidationError);

    runId = await createRun(h.db, state.userId, { seed: 1, effort: "schnell", versionId: draftId, schoolYearId: next }, today);
    const draft = (await getVersion(h.db, draftId))!;
    expect(await getRun(h.db, runId)).toMatchObject({ schoolYearId: next, params: { versionId: draftId, refYmd: draft.validFrom } });
    expect(await executeRun(h.db, runId, today)).toBe("done");
    const run = (await getRun(h.db, runId))!;
    expect(run.stored!.result.unplaced).toEqual([]);
    const proposal = proposedLessons(run.stored!);
    expect(proposal.length).toBeGreaterThan(0);
    expect(proposal.every((l) => nextGroups.has(l.groupId))).toBe(true);
    // Sperrzeiten (Zeitwünsche) des Folgejahrs gelten
    expect(proposal.filter((l) => l.groupId === new8b && BLOCKED.includes(prefKey(l.weekday, l.periodNr)))).toEqual([]);

    // Übernahme in den Entwurf des Folgejahrs
    const applied = await applyRunToDraft(h.db, state.userId, runId, { versionId: draftId }, today);
    expect(applied).toMatchObject({ versionId: draftId, from: draft.validFrom });
    expect(applied.created).toBe(proposal.length);
    const rows = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, draftId));
    expect(rows.length).toBe(proposal.length);
    expect(rows.every((r) => nextGroups.has(r.groupId) && r.validFrom === draft.validFrom && r.solverRunId === runId)).toBe(true);

    // nicht in einen Entwurf des laufenden Jahrs
    const curDraft = await createDraft(h.db, state.userId, { schoolYearId: current, source: "empty", validFrom: "2027-06-14", numbering: "major" }, today);
    await expect(applyRunToDraft(h.db, state.userId, runId, { versionId: curDraft.id }, today)).rejects.toMatchObject({ fieldErrors: { versionId: expect.stringMatching(/2027\/28/) } });

    // Warmstart ab dem Entwurf des Folgejahrs
    warmId = await createRun(h.db, state.userId, { seed: 2, effort: "schnell", versionId: draftId, mode: "entwurf", schoolYearId: next }, today);
    expect(await executeRun(h.db, warmId, today)).toBe("done");
    expect((await getRun(h.db, warmId))!.log.some((e) => e.kind === "construct" && /^Start aus dem Entwurf: \d+ von/.test(e.text))).toBe(true);

    // gültiger Plan und Lehraufträge des laufenden Jahrs unverändert
    expect(await liveRows()).toEqual(live);
    expect(await assignmentRows(current)).toEqual(curAssignments);
  }, 120_000);

  it("Fahrplan und Diagnose im Folgejahr: Rücklauf der Zeitwünsche, letzter Lauf im Entwurf, Zeitwünsche-Link mit Jahr", async () => {
    const loaded = await loadFahrplan(h.db, (await getVersion(h.db, draftId))!, today);
    expect(loaded.facts.year.id).toBe(next);
    expect(loaded.facts.wuensche).toMatchObject({ window: "open", submitted: 1 });
    expect(loaded.facts.setzen.lastRun).toMatchObject({ id: warmId, status: "done", unplaced: 0 });
    expect(loaded.facts.setzen.lessons).toBeGreaterThan(0);
    const step = loaded.fahrplan.steps.find((s) => s.step === "wuensche")!;
    expect(step.links.map((l) => l.href)).toContain(`/planung/zeitwuensche?jahr=${encodeURIComponent(next)}`);
    const setzen = loaded.fahrplan.steps.find((s) => s.step === "setzen")!;
    expect(setzen.links.map((l) => l.href)).toContain(`/planung/solver?quelle=${encodeURIComponent(draftId)}`);
  });

  it("Exporte im gewählten Schuljahr: Verteilung und Deputate des Folgejahrs (verplant im Entwurf), ohne Wahl das laufende", async () => {
    const cur = await buildExport(h.db, "verteilung", { today });
    expect(cur.subtitle).toMatch(/^Schuljahr 2026\/27/);
    const v = await buildExport(h.db, "verteilung", { today, yearId: next });
    expect(v.subtitle).toMatch(/^Schuljahr 2027\/28 · Stand /);
    const names = new Set((await h.db.select({ name: groups.name }).from(groups).where(eq(groups.schoolYearId, next))).map((g) => g.name));
    expect(v.rows.length).toBeGreaterThan(0);
    expect(v.rows.every((r) => names.has(r[0]!))).toBe(true);
    // Deputate: „verplant“ gegen den Entwurf des Folgejahrs, ohne Entwurf gegen den gültigen Plan (dort noch nichts)
    const planned = (t: Awaited<ReturnType<typeof buildExport>>) => t.rows.reduce((s, r) => s + Number(r[6]!.replace(",", ".")), 0);
    const inDraft = await buildExport(h.db, "deputate", { today, yearId: next, quelle: draftId });
    expect(inDraft.subtitle).toMatch(/^Schuljahr 2027\/28 · Stand .* · Entwurf /);
    expect(planned(inDraft)).toBeGreaterThan(0);
    expect(planned(await buildExport(h.db, "deputate", { today, yearId: next }))).toBe(0);
    // unbekanntes Jahr → laufendes (wie die Jahreswahl); Entwurf eines anderen Jahrs zählt nicht
    expect((await buildExport(h.db, "verteilung", { today, yearId: "gibt-es-nicht" })).subtitle).toMatch(/^Schuljahr 2026\/27/);
    expect((await buildExport(h.db, "deputate", { today, quelle: draftId })).subtitle).not.toMatch(/Entwurf/);
  });

  it("Freigabe und Veröffentlichen ab dem ersten Schultag des Folgejahrs: das laufende Schuljahr bleibt bis zum Vortag unverändert", async () => {
    const before = (await liveRows()).filter((l) => lessonActiveOn(l, today));
    const v = (await getVersion(h.db, draftId))!;
    await submitForReview(h.db, viewer, v.id, now);
    await approveVersion(h.db, viewer, v.id, now);
    await clearPublishGate(h.db, viewer.userId, v.id, today);
    await publishVersion(h.db, viewer.userId, v.id, v.validFrom!, today, now);
    const live = await liveRows();
    // Stichprobe: was heute gilt, gilt unverändert weiter (unbefristete Stunden enden jetzt am Vortag des Stichtags)
    const withoutEnd = (rows: typeof before) => rows.map((l) => ({ ...l, validUntil: null }));
    expect(withoutEnd(live.filter((l) => lessonActiveOn(l, today)))).toEqual(withoutEnd(before));
    expect(live.filter((l) => lessonActiveOn(l, today)).every((l) => l.validUntil !== null && l.validUntil < v.validFrom!)).toBe(true);
    const onFirst = live.filter((l) => lessonActiveOn(l, v.validFrom!));
    expect(onFirst.length).toBeGreaterThan(0);
    expect(onFirst.every((l) => nextGroups.has(l.groupId))).toBe(true);
    expect(onFirst.filter((l) => l.groupId === new8b && BLOCKED.includes(prefKey(l.weekday, l.periodNr)))).toEqual([]);
  }, 60_000);
});
