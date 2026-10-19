import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableAbsences, timetableSolverRuns, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb, createTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { createAbsence, needsOn } from "./abwesenheit";
import { SUBSTITUTION_RELEASE } from "./settings";
import { planningOverview } from "./uebersicht";
import { distribution, planningYear } from "./verteilung";
import { saveSubstitution } from "./vertretung";
import { setPrefWindow } from "./zeitwunsch-fenster";

// Mo 5.10.2026 – Schultag im Demo-Schuljahr
const TODAY = "2026-10-05";
const BOTH = { manage: true, substitute: true };

describe("Planungs-Übersicht (SP-04)", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableSubstitutions);
    await h.db.delete(timetableAbsences);
  }, 60_000);
  afterAll(() => h.close());

  it("Teile nur nach Recht: ohne `manage` keine Jahresplanung, ohne `substitute` kein Tagesgeschäft", async () => {
    const sub = await planningOverview(h.db, TODAY, { manage: false, substitute: true });
    expect(sub.manage).toBeNull();
    expect(sub.substitute).not.toBeNull();
    const man = await planningOverview(h.db, TODAY, { manage: true, substitute: false });
    expect(man.substitute).toBeNull();
    expect(man.manage).not.toBeNull();
    expect(man.year).toMatchObject({ isCurrent: true });
  });

  it("Lehraufträge: Zahlen wie in der Unterrichtsverteilung", async () => {
    const year = (await planningYear(h.db))!;
    const d = await distribution(h.db, year, TODAY);
    const { manage } = await planningOverview(h.db, TODAY, BOTH);
    const open = d.assignments.filter((a) => a.planned < a.hours);
    expect(manage!.refYmd).toBe(TODAY);
    expect(manage!.assignments).toEqual({
      total: d.assignments.length,
      open: open.length,
      openHours: open.reduce((s, a) => s + a.hours - a.planned, 0),
      over: d.assignments.filter((a) => a.planned > a.hours).length,
      unmatched: d.unmatched.length,
    });
    expect(manage!.assignments.total).toBeGreaterThan(0);
    expect(manage!.diagnosis.error).toBeGreaterThanOrEqual(0);
  });

  it("Zeitwunsch-Fenster: Zustand und abgegeben x von y; kein Lauf → `lastRun` leer", async () => {
    const before = (await planningOverview(h.db, TODAY, BOTH)).manage!;
    expect(before.prefWindow).toMatchObject({ state: "none", opensOn: null, submitted: 0 });
    expect(before.prefWindow.teachers).toBeGreaterThan(0);
    expect(before.lastRun).toBeNull();
    await setPrefWindow(h.db, "u-frank.schulte", { opensOn: TODAY, closesOn: "2026-10-16" }, TODAY);
    const after = (await planningOverview(h.db, TODAY, BOTH)).manage!;
    expect(after.prefWindow).toMatchObject({ state: "open", opensOn: TODAY, closesOn: "2026-10-16" });
  });

  it("Letzter Solver-Lauf: Bewertung und „nicht gesetzt“ aus dem Ergebnis, nur das Planungsjahr", async () => {
    const year = (await planningYear(h.db))!;
    await h.db.insert(timetableSolverRuns).values({
      schoolYearId: year.id,
      status: "done",
      progress: 100,
      createdAt: new Date("2026-10-04T10:00:00Z"),
      finishedAt: new Date("2026-10-04T10:01:00Z"),
      result: { result: { score: 123.5, unplaced: [{ unitId: "x", label: "M 7b", reason: "kein Slot" }], placements: [] }, units: [], keptLessonIds: [], refYmd: TODAY },
    });
    await h.db.insert(timetableSolverRuns).values({ schoolYearId: year.id, status: "running", progress: 40, createdAt: new Date("2026-10-04T09:00:00Z") });
    const { manage } = await planningOverview(h.db, TODAY, BOTH);
    expect(manage!.lastRun).toMatchObject({ status: "done", progress: 100, score: 123.5, unplaced: 1 });
  });

  it("Tagesgeschäft: Vertretungsbedarf je Tag, Entwürfe", async () => {
    const empty = (await planningOverview(h.db, TODAY, BOTH)).substitute!;
    expect(empty.days.map((d) => d.date)).toEqual([TODAY, "2026-10-06"]);
    expect(empty.days.every((d) => d.open === 0 && d.total === 0)).toBe(true);
    expect(empty.drafts).toEqual([]);
    expect(empty.duties.date).toBe(TODAY);

    await createAbsence(h.db, "u-frank.schulte", { teacherId: "u-jana.brandt", groupId: null, startsOn: TODAY, endsOn: TODAY, fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    const need = (await needsOn(h.db, TODAY)).open;
    const withNeed = (await planningOverview(h.db, TODAY, BOTH)).substitute!;
    expect(withNeed.days[0]).toEqual({ date: TODAY, open: need.filter((o) => o.status === "open").length, total: need.length });
    expect(withNeed.days[0]!.open).toBeGreaterThan(0);

    await writeModuleSetting(h.db, SUBSTITUTION_RELEASE, "freigabe");
    const first = need.find((o) => o.status === "open")!;
    await saveSubstitution(h.db, "u-frank.schulte", { lessonId: first.lessonId, date: TODAY, kind: "cancel", substituteId: null, roomId: null, note: null });
    const after = (await planningOverview(h.db, TODAY, BOTH)).substitute!;
    expect(after.days[0]!.open).toBe(withNeed.days[0]!.open - 1);
    expect(after.drafts).toEqual([TODAY]);
  });
});

describe("Planungs-Übersicht ohne Stammdaten (SP-04)", () => {
  it("ohne Schuljahr: keine Jahresplanung, Tagesgeschäft mit Nullen", async () => {
    const h = await createTestDb();
    try {
      const o = await planningOverview(h.db, TODAY, BOTH);
      expect(o.year).toBeNull();
      expect(o.manage).toBeNull();
      expect(o.substitute).toMatchObject({ drafts: [], duties: { open: 0, total: 0 }, roomBlocks: { count: 0, rooms: [] } });
      expect(o.substitute!.days.every((d) => d.open === 0)).toBe(true);
    } finally {
      await h.close();
    }
  });
});
