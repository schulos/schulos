// SP-14 (Q-SP-9-2): Kontolöschung bereinigt Lehrkraft-Kennungen in Solver-Läufen – auf Antrag (`deleteAccounts`) und im Löschlauf.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons, timetableSolverRuns, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteAccounts } from "@/core/privacy/konto";
import { runDeletion } from "@/core/privacy/loeschlauf";
import { applyRun, createRun, executeRun, getRun, proposedLessons } from "./solverlauf";
import { DELETED_TEACHER, labelPattern, runTeacherLabel, scrubIds } from "./solverlauf-konto";
import { planningYear } from "./verteilung";

const today = "2026-10-05";

describe("scrubIds", () => {
  it("ersetzt Kennungen als Wert und als Schlüssel, überall verschachtelt; anderes bleibt", () => {
    const ids = new Set(["u-weg"]);
    expect(scrubIds({ a: "u-weg", b: ["x", "u-weg", { c: "u-weg-nicht" }], "u-weg": 3, n: 1, z: null }, ids)).toEqual({
      a: DELETED_TEACHER,
      b: ["x", DELETED_TEACHER, { c: "u-weg-nicht" }],
      [DELETED_TEACHER]: 3,
      n: 1,
      z: null,
    });
    expect(scrubIds("text mit u-weg", ids)).toBe("text mit u-weg");
  });

  it("R2-P1: Kürzel = Fach-ID = Raum-ID – strukturelle IDs bleiben, nur Lehrkraft-Felder und Texte werden ersetzt", () => {
    const ids = new Set(["u-mu"]);
    const re = labelPattern(["MU"]);
    const stored = {
      units: [
        {
          id: "a-1#d0",
          label: "7b Musik (MU + BRA)",
          groupIds: ["MU"],
          teacherIds: ["u-mu", "u-x.MU"],
          subjectId: "MU",
          length: 2,
          parts: [{ assignmentId: "MU", groupIds: ["MU"], teacherIds: ["u-mu"], subjectId: "MU", roomId: "MU", roomKind: "MU", homeRoomId: "MU", size: 20 }],
        },
      ],
      result: {
        placements: [{ unitId: "MU", weekday: 0, periodNr: 1, roomId: "MU", roomIds: ["MU"] }],
        unplaced: [{ unitId: "MU", label: "7b Musik (MU)", reason: "kein Slot frei – Lehrkraft MU: 0 von 30 frei", causes: [{ kind: "teacher", id: "u-mu", label: "MU", free: 0, of: 30, busy: 0, blocked: 0 }] }],
        items: [{ category: "teacherGap", cost: 3, text: "MU Mo: 2 Hohlstunden" }],
      },
      keptLessonIds: ["MU"],
      refYmd: "2026-11-02",
    };
    const undo = {
      ended: [{ id: "MU", validUntil: null }],
      deleted: [{ id: "MU", groupId: "MU", weekday: 0, periodNr: 1, subjectId: "MU", teacherId: "u-mu", roomId: "MU", week: "all", validFrom: "2026-11-09", validUntil: null, couplingId: "MU", fixed: false, solverRunId: null }],
      removedSubstitutions: 1,
      substitutions: [{ id: "s-1", lessonId: "MU", date: "2026-11-09", kind: "substitute", substituteId: "u-mu", roomId: "MU", note: "MU übernimmt", subjectId: "MU", createdBy: "u-x.MU", createdAt: "2026-10-01T00:00:00.000Z" }],
    };
    const log = [{ at: "2026-10-01T00:00:00.000Z", kind: "precheck", text: "Vorprüfung: Lehrkraft MU knapp", data: { findings: [{ severity: "warn", kind: "teacher", id: "u-mu", label: "MU", demand: 28, free: 29, message: "MU: 28 von 29" }], byTeacher: { "u-mu": 2, "u-x.MU": 1 } } }];

    const s = scrubIds(stored, ids, re) as typeof stored;
    const unit = s.units[0]!;
    expect(unit).toMatchObject({ id: "a-1#d0", groupIds: ["MU"], subjectId: "MU", teacherIds: [DELETED_TEACHER, "u-x.MU"], label: `7b Musik (${DELETED_TEACHER} + BRA)` });
    expect(unit.parts[0]).toEqual({ assignmentId: "MU", groupIds: ["MU"], teacherIds: [DELETED_TEACHER], subjectId: "MU", roomId: "MU", roomKind: "MU", homeRoomId: "MU", size: 20 });
    expect(s.result.placements).toEqual(stored.result.placements);
    expect(s.result.unplaced[0]).toMatchObject({ unitId: "MU", reason: `kein Slot frei – Lehrkraft ${DELETED_TEACHER}: 0 von 30 frei`, causes: [{ id: DELETED_TEACHER, label: DELETED_TEACHER }] });
    expect(s.result.items[0]!.text).toBe(`${DELETED_TEACHER} Mo: 2 Hohlstunden`);
    expect(s.keptLessonIds).toEqual(["MU"]);

    const u = scrubIds(undo, ids, re) as typeof undo;
    expect(u.ended).toEqual(undo.ended);
    expect(u.deleted[0]).toEqual({ ...undo.deleted[0], teacherId: DELETED_TEACHER });
    expect(u.substitutions[0]).toEqual({ ...undo.substitutions[0], substituteId: DELETED_TEACHER, note: `${DELETED_TEACHER} übernimmt` });

    const l = scrubIds(log, ids, re) as typeof log;
    expect(l[0]!.text).toBe(`Vorprüfung: Lehrkraft ${DELETED_TEACHER} knapp`);
    expect(l[0]!.kind).toBe("precheck");
    expect(l[0]!.data.findings[0]).toMatchObject({ kind: "teacher", id: DELETED_TEACHER, label: DELETED_TEACHER, message: `${DELETED_TEACHER}: 28 von 29` });
    expect(l[0]!.data.byTeacher).toEqual({ [DELETED_TEACHER]: 2, "u-x.MU": 1 });
  });

  it("R2-P1: schon bereinigte Altbestände bleiben stabil – zweite Löschung ändert den Platzhalter nicht, Kennungen anderer bleiben", () => {
    const old = {
      units: [{ id: "a-1#e0", label: `7b Musik (${DELETED_TEACHER} + Lehrkraft)`, groupIds: ["g-7b"], teacherIds: [DELETED_TEACHER, "u-lehrkraft"], subjectId: "MU", length: 1 }],
      result: { items: [{ category: "teacherGap", cost: 1, text: `${DELETED_TEACHER} Di: 1 Hohlstunde; Lehrkraft Di` }] },
    };
    // zweite gelöschte Lehrkraft heißt „Lehrkraft“ – das Wort im Platzhalter bleibt unberührt
    const s = scrubIds(old, new Set(["u-lehrkraft"]), labelPattern(["Lehrkraft"])) as typeof old;
    expect(s.units[0]).toEqual({ ...old.units[0], label: `7b Musik (${DELETED_TEACHER} + ${DELETED_TEACHER})`, teacherIds: [DELETED_TEACHER, DELETED_TEACHER] });
    expect(s.result.items[0]!.text).toBe(`${DELETED_TEACHER} Di: 1 Hohlstunde; ${DELETED_TEACHER} Di`);
    expect(scrubIds(s, new Set(["u-lehrkraft"]), labelPattern(["Lehrkraft"]))).toEqual(s);
  });

  it("Anzeige: Kürzel, Platzhalter für gelöschte, sonst nichts", () => {
    const codes = new Map([["u-a", "AAA"]]);
    expect(runTeacherLabel(codes, "u-a")).toBe("AAA");
    expect(runTeacherLabel(codes, DELETED_TEACHER)).toBe("gelöschte Lehrkraft");
    expect(runTeacherLabel(codes, "u-unbekannt")).toBeNull();
    expect(runTeacherLabel(codes, null)).toBeNull();
  });
});

describe("SP-14 Kontolöschung und Solver-Läufe (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  const json = async (id: string) => {
    const [r] = await h.db.select().from(timetableSolverRuns).where(eq(timetableSolverRuns.id, id));
    return JSON.stringify([r!.params, r!.result, r!.undo, r!.log]);
  };

  it("deleteAccounts: Kennung in Vorschlag, Rücknahme-Daten und Protokoll → „gelöschte Lehrkraft“; Vorschau und Übernahme kommen damit klar", async () => {
    const year = (await planningYear(h.db))!;
    const id = await createRun(h.db, "u-admin", { seed: 3, effort: "schnell" }, today);
    expect(await executeRun(h.db, id, today)).toBe("done");
    const run = (await getRun(h.db, id))!;
    const teacher = run.stored!.units.flatMap((u) => u.teacherIds).find((t) => t !== "u-frank.schulte")!;
    const other = run.stored!.units.flatMap((u) => u.teacherIds).find((t) => t !== teacher)!;
    const rowsOfTeacher = proposedLessons(run.stored!).filter((l) => l.teacherId === teacher).length;
    expect(rowsOfTeacher).toBeGreaterThan(0);
    // zweiter Lauf mit Rücknahme-Daten und Protokoll, in denen die Lehrkraft vorkommt (auch als Schlüssel)
    await h.db.insert(timetableSolverRuns).values({
      id: "run-undo",
      schoolYearId: year.id,
      status: "applied",
      appliedFrom: "2026-11-02",
      params: run.params,
      log: [{ at: new Date().toISOString(), kind: "precheck", text: "Vorprüfung", data: { findings: [{ kind: "teacher", id: teacher, label: "Lehrkraft X" }], byTeacher: { [teacher]: 2, [other]: 1 } } }],
      undo: {
        ended: [],
        deleted: [{ id: "l-x", groupId: "g-7b", weekday: 0, periodNr: 1, subjectId: "M", teacherId: teacher, roomId: null, week: "all", validFrom: "2026-11-09", validUntil: null, couplingId: null, fixed: false, solverRunId: null }],
        removedSubstitutions: 1,
        substitutions: [{ id: "s-x", lessonId: "l-x", date: "2026-11-09", kind: "substitute", substituteId: teacher, roomId: null, note: null, subjectId: null, createdBy: "u-admin", createdAt: new Date().toISOString() }],
      },
    });
    const paramsBefore = run.params;

    await deleteAccounts(h.db, [teacher]);
    expect(await h.db.$count(users, eq(users.id, teacher))).toBe(0);
    for (const r of [id, "run-undo"]) {
      const text = await json(r);
      expect(text).not.toContain(`"${teacher}"`);
      expect(text).toContain(DELETED_TEACHER);
    }
    // andere Lehrkräfte und Parameter bleiben unverändert
    expect(await json("run-undo")).toContain(`"${other}"`);
    const after = (await getRun(h.db, id))!;
    expect(after.params).toEqual(paramsBefore);
    expect(proposedLessons(after.stored!).filter((l) => l.teacherId === DELETED_TEACHER).length).toBe(rowsOfTeacher);
    const undo = (await getRun(h.db, "run-undo"))!.undo!;
    expect(undo.deleted[0]!.teacherId).toBe(DELETED_TEACHER);
    expect(undo.substitutions![0]).toMatchObject({ substituteId: DELETED_TEACHER, createdBy: "u-admin" });

    // Übernahme: die Stunden der gelöschten Lehrkraft werden ohne Lehrkraft angelegt (kein Fremdschlüssel-Fehler)
    const res = await applyRun(h.db, "u-admin", id, "2026-11-02", today);
    expect(res.created).toBe(proposedLessons(after.stored!).length);
    expect(await h.db.$count(timetableLessons, and(eq(timetableLessons.solverRunId, id), isNull(timetableLessons.teacherId)))).toBeGreaterThanOrEqual(rowsOfTeacher);
  }, 120_000);

  it("Löschlauf: Konto nach Abgang und Karenz → Kennung in Solver-Läufen ersetzt", async () => {
    const year = (await planningYear(h.db))!;
    await h.db.insert(users).values({ id: "u-weg", name: "Lehrkraft Weg", email: "weg@schule.test", role: "lehrkraft", status: "locked", leftOn: "2025-01-10" });
    await h.db.insert(timetableSolverRuns).values({
      id: "run-weg",
      schoolYearId: year.id,
      status: "done",
      result: { units: [{ id: "x", label: "M 7b", groupIds: ["g-7b"], teacherIds: ["u-weg", "u-jana.brandt"], subjectId: "M", length: 1 }] },
      log: [{ at: new Date().toISOString(), kind: "warning", text: "Hinweis", data: { teacher: "u-weg" } }],
    });
    const out = await runDeletion(h.db, "u-admin", today);
    expect(out.items.find((i) => i.table === "users" && !i.error)?.deleted).toBeGreaterThanOrEqual(1);
    expect(await h.db.$count(users, eq(users.id, "u-weg"))).toBe(0);
    const text = await json("run-weg");
    expect(text).not.toContain('"u-weg"');
    expect(text).toContain('"u-jana.brandt"');
    expect(JSON.parse(text)[1].units[0].teacherIds).toEqual([DELETED_TEACHER, "u-jana.brandt"]);
  }, 120_000);
});

describe("R2-P1 Kontolöschung: Kürzel = Fach-ID (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Lehrkraft mit Kürzel „MU“ (= Fach MU) gelöscht → Fächer/Räume im Lauf bleiben, Übernahme ohne Fremdschlüssel-Fehler", async () => {
    const [ric] = await h.db.select({ id: users.id }).from(users).where(eq(users.shortCode, "RIC"));
    await h.db.update(users).set({ shortCode: "MU" }).where(eq(users.id, ric!.id));
    const id = await createRun(h.db, "u-admin", { seed: 5, effort: "schnell" }, today);
    expect(await executeRun(h.db, id, today)).toBe("done");
    const before = (await getRun(h.db, id))!;
    const subjectsOf = (r: typeof before) => r.stored!.units.flatMap((u) => [u.subjectId, ...(u.parts ?? []).map((p) => p.subjectId)]);
    expect(subjectsOf(before)).toContain("MU");
    expect(before.stored!.units.some((u) => u.teacherIds.includes(ric!.id))).toBe(true);

    await deleteAccounts(h.db, [ric!.id]);
    const after = (await getRun(h.db, id))!;
    expect(subjectsOf(after)).toEqual(subjectsOf(before));
    expect(after.stored!.result.placements).toEqual(before.stored!.result.placements);
    expect(after.stored!.units.flatMap((u) => u.teacherIds)).not.toContain(ric!.id);
    expect(after.stored!.units.some((u) => u.teacherIds.includes(DELETED_TEACHER))).toBe(true);
    // Texte: Kürzel ersetzt (Einheiten-Bezeichnung „… Musik (MU)“)
    expect(after.stored!.units.map((u) => u.label).join("|")).not.toMatch(/\(MU\)/);

    const res = await applyRun(h.db, "u-admin", id, "2026-11-02", today);
    expect(res.created).toBe(proposedLessons(after.stored!).length);
  }, 120_000);
});
