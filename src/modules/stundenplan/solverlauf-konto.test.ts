// SP-14 (Q-SP-9-2): Kontolöschung bereinigt Lehrkraft-Kennungen in Solver-Läufen – auf Antrag (`deleteAccounts`) und im Löschlauf.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons, timetableSolverRuns, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteAccounts } from "@/core/privacy/konto";
import { runDeletion } from "@/core/privacy/loeschlauf";
import { applyRun, createRun, executeRun, getRun, proposedLessons } from "./solverlauf";
import { DELETED_TEACHER, runTeacherLabel, scrubIds } from "./solverlauf-konto";
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
