// SQ-02: Lauf „ab aktuellem Entwurf verbessern“ auf der Demo-Schule – Start aus den Entwurfsstunden, fixierte Stunden bleiben, offene
// Stunden werden eingeplant, nie schlechter als der Start, deterministisch, Übernahme in den Entwurf über den SP3-02-Weg.
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableDraftLessons, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { createDraft } from "./planversionen";
import { applyRunToDraft, createRun, executeRun, getRun, parseParams, setFixed } from "./solverlauf";
import { draftOf } from "./plan-quelle";
import { unchangedUnits } from "./solver";
import { planningYear } from "./verteilung";

const today = "2026-10-05";
const cutoff = "2027-02-01";

describe("Ab aktuellem Entwurf verbessern (SQ-02, Demo-Schule)", () => {
  let h: DbHandle;
  let draftId: string;
  let fixedId: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    const year = (await planningYear(h.db))!;
    draftId = (
      await createDraft(
        h.db,
        "u-frank.schulte",
        {
          schoolYearId: year.id,
          source: "live_copy",
          validFrom: cutoff,
          numbering: "major",
          name: "Halbjahr",
        },
        today,
      )
    ).id;
    const rows = await h.db
      .select()
      .from(timetableDraftLessons)
      .where(and(eq(timetableDraftLessons.versionId, draftId), isNull(timetableDraftLessons.couplingId), eq(timetableDraftLessons.fixed, false)))
      .orderBy(asc(timetableDraftLessons.groupId), asc(timetableDraftLessons.weekday), asc(timetableDraftLessons.periodNr), asc(timetableDraftLessons.id));
    // eine Stunde fixieren, eine andere (andere Gruppe) entfernen – sie ist danach im Entwurf offen
    fixedId = rows[0]!.id;
    await setFixed(h.db, "u-frank.schulte", fixedId, true, draftOf(draftId));
    const open = rows.find((r) => r.groupId !== rows[0]!.groupId)!;
    await h.db.delete(timetableDraftLessons).where(eq(timetableDraftLessons.id, open.id));
  });
  afterAll(() => h.close());

  const errorOf = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0]!;
      throw err;
    }
    throw new Error("keine ValidationError");
  };

  it("Parameter: nur im Entwurf, Umfang nur mit dem Warmstart", () => {
    expect(errorOf(() => parseParams({ mode: "entwurf" }))).toMatch(/nur in einem Entwurf/);
    expect(errorOf(() => parseParams({ mode: "irgendwas", versionId: "v" }))).toMatch(/Unbekanntes Vorgehen/);
    expect(errorOf(() => parseParams({ mode: "entwurf", versionId: "v", scope: "x" }))).toMatch(/Unbekannter Umfang/);
    expect(parseParams({ mode: "entwurf", versionId: "v", scope: "schwach" })).toMatchObject({ mode: "entwurf", scope: "schwach", versionId: "v" });
    // neu planen: weder Modus noch Umfang im Lauf (wie vor SQ-02)
    const neu = parseParams({ mode: "neu", versionId: "v", scope: "schwach" });
    expect(neu.mode).toBeUndefined();
    expect(neu.scope).toBeUndefined();
  });

  it("startet vom Entwurf, plant die offene Stunde ein, wird nicht schlechter, Fixiertes bleibt; Übernahme in den Entwurf, gültiger Plan unverändert", async () => {
    const live = (await h.db.select().from(timetableLessons)).sort((a, b) => a.id.localeCompare(b.id));
    const id = await createRun(h.db, "u-frank.schulte", { seed: 4, effort: "schnell", versionId: draftId, mode: "entwurf" }, today);
    expect(await executeRun(h.db, id, today)).toBe("done");
    const run = (await getRun(h.db, id))!;
    expect(run.params).toMatchObject({ mode: "entwurf", versionId: draftId });
    const m = run.metrics!;
    expect(m.warm).toBeDefined();
    const w = m.warm!;
    expect(w.startUnplaced).toBeGreaterThanOrEqual(1);
    expect(m.unplaced).toBe(0);
    expect(w.rounds).toBeGreaterThan(0);
    expect(m.steps).toBe(w.rounds);
    // fast alles bleibt, wo es im Entwurf lag
    expect(w.unchanged / w.startUnits).toBeGreaterThan(0.8);
    expect(run.log.some((e) => e.kind === "construct" && e.text.startsWith("Start aus dem Entwurf"))).toBe(true);
    expect(run.log.find((e) => e.kind === "done")!.text).toMatch(/^Fertig: Bewertung \d+ → \d+, nicht gesetzt \d+ → 0, \d+ Runden \(\d+ Verbesserungen übernommen\)/);
    expect(run.stored!.keptLessonIds).toContain(fixedId);
    // deterministisch: gleicher Startwert, gleiches Ergebnis
    const again = await createRun(h.db, "u-frank.schulte", { seed: 4, effort: "schnell", versionId: draftId, mode: "entwurf" }, today);
    await executeRun(h.db, again, today);
    expect((await getRun(h.db, again))!.stored!.result.placements).toEqual(run.stored!.result.placements);

    const res = await applyRunToDraft(h.db, "u-frank.schulte", id, { versionId: draftId }, today);
    expect(res.created).toBeGreaterThan(0);
    const after = await h.db.select().from(timetableDraftLessons).where(eq(timetableDraftLessons.versionId, draftId));
    expect(after.find((r) => r.id === fixedId)).toMatchObject({ fixed: true });
    expect((await h.db.select().from(timetableLessons)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(live);

    // zweiter Warmstart auf dem übernommenen Entwurf: nichts mehr offen, Start = Ergebnis des ersten Laufs
    const second = await createRun(
      h.db,
      "u-frank.schulte",
      {
        seed: 5,
        effort: "schnell",
        versionId: draftId,
        mode: "entwurf",
        scope: "schwach",
      },
      today,
    );
    expect(await executeRun(h.db, second, today)).toBe("done");
    const r2 = (await getRun(h.db, second))!;
    expect(r2.metrics!.warm).toMatchObject({
      startUnplaced: 0,
      scope: "schwach",
      startScore: m.score,
    });
    expect(r2.metrics!.score).toBeLessThanOrEqual(m.score);
    expect(unchangedUnits(run.stored!.result.placements, r2.stored!.result.placements) / run.stored!.result.placements.length).toBeGreaterThan(0.8);
  });
});
