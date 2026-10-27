// SP3-02: Arbeiten im Entwurf – Setzhilfe, Pflege, Fixieren, Diagnose, Verteilung, Solver-Eingabe, Solver-Lauf und Übernahme in den
// Entwurf (F-10-1), Diff zum gültigen Plan und Variantenvergleich. Der gültige Plan bleibt dabei Zeile für Zeile unverändert.
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableDraftLessons, timetableLessons, timetablePlanVersions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { diagnoseYear, groupPlanFindings } from "./diagnose";
import { createLesson, deleteLesson, lessonsOfGroup, saveCoupling } from "./manage";
import { loadPlanDiff } from "./plan-diff";
import { draftOf, LIVE } from "./plan-quelle";
import { createDraft, createVariant, discardVersion } from "./planversionen";
import { resolveQuelle, writableSource } from "./quelle";
import { moveLesson, openAssignments, placeAssignment, assignmentPlacement, placementGrid } from "./setzhilfe";
import { solverInputFromDb } from "./solver-input";
import { applyRunToDraft, createRun, executeRun, getRun, proposalDiagnosis, proposedLessons, setFixed } from "./solverlauf";
import { loadVersionComparison } from "./solververgleich";
import { distribution, planningYear } from "./verteilung";

const today = "2026-10-05";
const cutoff = "2027-02-01";

describe("Arbeiten im Entwurf (SP3-02, Demo-Schule)", () => {
  let h: DbHandle;
  let draftId: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    const year = (await planningYear(h.db))!;
    draftId = (await createDraft(h.db, "u-frank.schulte", { schoolYearId: year.id, source: "live_copy", validFrom: cutoff, numbering: "major", name: "Halbjahr" }, today)).id;
  });
  afterAll(() => h.close());

  const liveSnapshot = async () => (await h.db.select().from(timetableLessons)).sort((a, b) => a.id.localeCompare(b.id));
  const draftRows = () => h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, draftId));
  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0]!;
      throw err;
    }
    throw new Error("keine ValidationError");
  };

  it("Quellen-Wähler: gültiger Plan und offene Entwürfe; Unbekanntes fällt auf den gültigen Plan zurück, Schreiben nur in Entwürfe", async () => {
    const year = (await planningYear(h.db))!;
    const q = await resolveQuelle(h.db, draftId, year.id);
    expect(q).toMatchObject({ value: draftId, source: { kind: "draft", versionId: draftId }, editable: true, label: "Entwurf 2.0 „Halbjahr“" });
    expect(q.options.map((o) => o.label)).toEqual(["Gültiger Plan", "Entwurf 2.0 „Halbjahr“"]);
    expect((await resolveQuelle(h.db, "gibt-es-nicht", year.id)).source).toEqual(LIVE);
    expect((await resolveQuelle(h.db, undefined, year.id)).value).toBe("gueltig");
    expect(await writableSource(h.db, "gueltig")).toEqual(LIVE);
    expect(await errorOf(writableSource(h.db, "gibt-es-nicht"))).toMatch(/gibt es nicht mehr/);
  });

  it("Setzhilfe, Pflege, Kopplung und Fixieren schreiben nur in den Entwurf – der gültige Plan bleibt Zeile für Zeile", async () => {
    const source = draftOf(draftId);
    const before = await liveSnapshot();
    const draft7b = await lessonsOfGroup(h.db, "g-7b", cutoff, source);
    expect(draft7b.length).toBeGreaterThan(20);
    const target = draft7b.find((r) => !r.l.couplingId)!;

    // Stunde im Entwurf löschen → im Entwurf offen, im gültigen Plan nicht
    const liveOpen = (await openAssignments(h.db, "g-7b", cutoff)).find((a) => a.subjectId === target.l.subjectId)?.open ?? 0;
    await deleteLesson(h.db, "u-frank.schulte", target.l.id, today, source);
    const open = (await openAssignments(h.db, "g-7b", cutoff, source)).find((a) => a.subjectId === target.l.subjectId)!;
    expect(open.open).toBe(liveOpen + 1);
    expect((await openAssignments(h.db, "g-7b", cutoff)).find((a) => a.subjectId === target.l.subjectId)?.open ?? 0).toBe(liveOpen);

    // Setzhilfe im Entwurf: Freiraster gegen den Entwurf, die neue Stunde trägt den Lehrauftrag und beginnt am Stichtag
    const pl = await assignmentPlacement(h.db, open, today, cutoff, source);
    expect(pl.validity.validFrom).toBe(cutoff);
    const free = [...placementGrid({ ...pl, unitIds: [], weekdays: [0, 1, 2, 3, 4], periods: [1, 2, 3, 4, 5, 6, 7, 8] })].filter(([, c]) => c.state === "free");
    expect(free.length).toBeGreaterThan(1);
    const [d, p] = free[0]![0].split("-").map(Number);
    await placeAssignment(h.db, "u-frank.schulte", open.id, "g-7b", d!, p!, today, cutoff, source);
    const [placed] = await h.db
      .select()
      .from(timetableDraftLessons)
      .where(and(eq(timetableDraftLessons.versionId, draftId), eq(timetableDraftLessons.groupId, "g-7b"), eq(timetableDraftLessons.weekday, d!), eq(timetableDraftLessons.periodNr, p!)));
    expect(placed).toMatchObject({ subjectId: target.l.subjectId, assignmentId: open.id, validFrom: cutoff, originLessonId: null });

    // Verschieben im Entwurf
    const [d2, p2] = free[1]![0].split("-").map(Number);
    expect(await moveLesson(h.db, "u-frank.schulte", placed!.id, "g-7b", d2!, p2!, source)).toBe("moved");
    const [moved] = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.id, placed!.id));
    expect([moved!.weekday, moved!.periodNr]).toEqual([d2, p2]);
    // im gültigen Plan gibt es die Entwurfsstunde nicht
    await expect(moveLesson(h.db, "u-frank.schulte", placed!.id, "g-7b", d!, p!)).rejects.toBeInstanceOf(ValidationError);

    // Kollisionen zählen nur im Entwurf: der frei gewordene Slot ist im Entwurf belegbar, im gültigen Plan nicht
    const input = { groupId: "g-7b", weekday: target.l.weekday, periodNr: target.l.periodNr, subjectId: target.l.subjectId, teacherId: null, roomId: null, week: "all" as const, validFrom: cutoff, validUntil: null };
    expect(await errorOf(createLesson(h.db, "u-frank.schulte", input))).toMatch(/hat .* schon eine Stunde/);
    const extra = await createLesson(h.db, "u-frank.schulte", input, source);
    expect(await errorOf(createLesson(h.db, "u-frank.schulte", input, source))).toMatch(/hat .* schon eine Stunde/);

    // Kopplung im Entwurf (aus der neuen Stunde erweitern), dann fixieren – fixiert werden alle Teile
    const other = draft7b.find((r) => r.l.subjectId !== target.l.subjectId)!.l.subjectId;
    const couplingId = await saveCoupling(
      h.db,
      "u-frank.schulte",
      null,
      {
        weekday: target.l.weekday,
        periodNr: target.l.periodNr,
        week: "all",
        validFrom: cutoff,
        validUntil: null,
        parts: [
          { id: extra, groupId: "g-7b", subjectId: target.l.subjectId, teacherId: null, roomId: null },
          { groupId: "g-7b", subjectId: other, teacherId: null, roomId: null },
        ],
      },
      source,
    );
    const parts = (await draftRows()).filter((r) => r.couplingId === couplingId);
    expect(parts).toHaveLength(2);
    await setFixed(h.db, "u-frank.schulte", extra, true, source);
    expect((await draftRows()).filter((r) => r.couplingId === couplingId).every((r) => r.fixed)).toBe(true);

    expect(await liveSnapshot()).toEqual(before);
    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog)).map((a) => a.action);
    for (const a of ["stundenplan.draft.lesson.delete", "stundenplan.draft.lesson.create", "stundenplan.draft.lesson.update", "stundenplan.draft.coupling.create", "stundenplan.draft.lesson.fix"])
      expect(actions).toContain(a);
  });

  it("verworfene Entwürfe sind nicht bearbeitbar", async () => {
    const variant = await createVariant(h.db, "u-frank.schulte", draftId);
    await discardVersion(h.db, "u-frank.schulte", variant.id);
    const [row] = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, variant.id)).limit(1);
    expect(await errorOf(setFixed(h.db, "u-admin", row!.id, true, draftOf(variant.id)))).toMatch(/kein Entwurf mehr/);
    expect(await errorOf(deleteLesson(h.db, "u-admin", row!.id, today, draftOf(variant.id)))).toMatch(/kein Entwurf mehr/);
    expect(await errorOf(writableSource(h.db, variant.id))).toMatch(/kein Entwurf mehr/);
  });

  it("Verteilung, Diagnose und Solver-Eingabe lesen den Entwurf (Prüflogik unverändert)", async () => {
    const year = (await planningYear(h.db))!;
    const source = draftOf(draftId);
    const live = await distribution(h.db, year, cutoff);
    const draft = await distribution(h.db, year, cutoff, { source });
    const rows = await draftRows();
    expect(draft.groups.reduce((s, g) => s + g.planned, 0)).toBe(rows.filter((r) => r.validFrom <= cutoff).reduce((s, r) => s + (r.week === "all" ? 1 : 0.5), 0));
    expect(draft.groups.find((g) => g.id === "g-7b")!.planned).not.toBe(live.groups.find((g) => g.id === "g-7b")!.planned);

    const liveReport = await diagnoseYear(h.db, year, cutoff, 25.5);
    const draftReport = await diagnoseYear(h.db, year, cutoff, 25.5, undefined, { source });
    expect(draftReport.refYmd).toBe(cutoff);
    expect(draftReport.findings).not.toEqual(liveReport.findings);
    // die zusätzliche Stunde ohne Lehrkraft/Raum im Entwurf: Gruppen-Hinweise kommen aus dem Entwurf
    expect(await groupPlanFindings(h.db, "g-7b", cutoff, source)).toEqual(expect.any(Array));

    const liveInput = await solverInputFromDb(h.db, year, cutoff, { seed: 1 });
    const draftInput = await solverInputFromDb(h.db, year, cutoff, { seed: 1, source });
    const fixedDraft = rows.filter((r) => r.fixed).map((r) => r.id);
    expect(fixedDraft.length).toBeGreaterThan(0);
    for (const id of fixedDraft) expect(draftInput.keptLessonIds).toContain(id);
    expect((liveInput.keptLessonIds ?? []).some((id) => fixedDraft.includes(id))).toBe(false);
  });

  it("Solver-Lauf im Entwurf, Übernahme in den Entwurf (F-10-1) und nicht in den gültigen Plan; Diff und neuer Entwurf aus einem Lauf", async () => {
    const id = await createRun(h.db, "u-frank.schulte", { seed: 2, effort: "schnell", versionId: draftId }, today);
    const queued = (await getRun(h.db, id))!;
    // Planungsstand = Stichtag des Entwurfs
    expect(queued.params).toMatchObject({ versionId: draftId, refYmd: cutoff });
    expect(await executeRun(h.db, id, today)).toBe("done");
    const run = (await getRun(h.db, id))!;
    expect(run.stored!.versionId).toBe(draftId);
    const fixed = (await draftRows()).filter((r) => r.fixed);
    for (const r of fixed) expect(run.stored!.keptLessonIds).toContain(r.id);
    // behaltene Stunden der Vorschau/Diagnose kommen aus dem Entwurf
    expect(await proposalDiagnosis(h.db, run.stored!)).toEqual(expect.any(Array));
    expect(run.stored!.result.unplaced).toEqual([]);

    const before = await liveSnapshot();
    const res = await applyRunToDraft(h.db, "u-frank.schulte", id, { versionId: draftId }, today);
    expect(res).toMatchObject({ versionId: draftId, from: cutoff, created: proposedLessons(run.stored!).length });
    expect(res.kept).toBeGreaterThanOrEqual(fixed.length);
    expect(res.replaced).toBeGreaterThan(0);
    expect(res.withOrigin).toBeGreaterThan(0);
    expect(await liveSnapshot()).toEqual(before);
    const rows = await draftRows();
    expect(rows.filter((r) => r.solverRunId === id)).toHaveLength(res.created);
    for (const r of fixed) expect(rows.some((x) => x.id === r.id && x.fixed)).toBe(true);
    expect(rows.filter((r) => r.solverRunId === id).every((r) => r.validFrom === cutoff && r.assignmentId !== null)).toBe(true);
    // Lauf bleibt „fertig“ (nochmals übernehmbar), Protokoll und Audit nennen den Entwurf; die Version merkt sich den Lauf
    const after = (await getRun(h.db, id))!;
    expect(after.status).toBe("done");
    expect(after.log.at(-1)).toMatchObject({ kind: "apply", text: expect.stringContaining("In den Entwurf 2.0") });
    const [v] = await h.db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, draftId));
    expect(v!.sourceRunId).toBe(id);
    expect(await h.db.$count(auditLog, eq(auditLog.action, "stundenplan.solver.apply_draft"))).toBe(1);

    // Diff zum gültigen Plan am Stichtag
    const diff = await loadPlanDiff(h.db, draftId, null, today);
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.before.source).toEqual({ kind: "live", refYmd: cutoff });
      expect(diff.diff.counts.changed + diff.diff.counts.added + diff.diff.counts.removed).toBeGreaterThan(0);
      expect(diff.diff.byTeacher.size).toBeGreaterThan(0);
      expect(diff.diff.byGroup.get("g-7b")?.length).toBeGreaterThan(0);
    }

    // neuer Entwurf aus dem Lauf: Kopie des gültigen Plans, Quelle „Solver-Lauf“
    const fresh = await applyRunToDraft(h.db, "u-frank.schulte", id, { newDraft: { validFrom: cutoff } }, today);
    const [nv] = await h.db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, fresh.versionId));
    expect(nv).toMatchObject({ source: "solver_run", sourceRunId: id, status: "entwurf", validFrom: cutoff, name: "Aus Solver-Lauf" });
    expect(await h.db.$count(timetableDraftLessons, and(eq(timetableDraftLessons.versionId, nv!.id), eq(timetableDraftLessons.solverRunId, id)))).toBe(fresh.created);
    expect(await h.db.$count(timetableDraftLessons, and(eq(timetableDraftLessons.versionId, nv!.id), isNotNull(timetableDraftLessons.originLessonId)))).toBeGreaterThan(0);

    // in einen verworfenen Entwurf nicht
    await discardVersion(h.db, "u-frank.schulte", nv!.id);
    expect(await errorOf(applyRunToDraft(h.db, "u-frank.schulte", id, { versionId: nv!.id }, today))).toMatch(/kein Entwurf mehr/);
    expect(await liveSnapshot()).toEqual(before);
  });

  it("Variantenvergleich über die Quelle „Version“", async () => {
    const variant = await createVariant(h.db, "u-frank.schulte", draftId);
    const res = await loadVersionComparison(h.db, [draftId, variant.id], today, 25.5);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.versions.map((v) => [v.label, v.refYmd])).toEqual([
      ["2.0", cutoff],
      ["2.0", cutoff],
    ]);
    // eine Variante ist eine Kopie: gleiche Zahlen, kein Unterschied
    expect(res.rows.every((r) => r.deltas.every((d) => d === 0))).toBe(true);
    const active = (await draftRows()).filter((r) => r.validFrom <= cutoff && (r.validUntil === null || r.validUntil >= cutoff));
    expect(res.rows.find((r) => r.key === "lessons")!.values[0]).toBe(active.length);
    const diff = await loadPlanDiff(h.db, variant.id, draftId, today);
    expect(diff.ok && diff.diff.counts.changed + diff.diff.counts.added + diff.diff.counts.removed).toBe(0);
    expect((await loadVersionComparison(h.db, [draftId], today, 25.5)).ok).toBe(false);
  });
});
