// Solver-Bedienung (P2b-23): Lauf als Hintergrundjob mit Fortschritt, Vorschau mit Bewertung und Diagnose,
// Übernahme ab Stichtag. Fixierte Stunden und Stunden ohne Lehrauftrag bleiben.
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { runExclusive } from "@/core/jobs";
import { audit } from "@/core/audit";
import { groupMembers, groups, periods, rooms, subjects, timetableLessons, timetableSolverRuns, timetableSubstitutions, users } from "@/core/db/schema";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { diagnose, type DiagLesson, type Finding } from "./diagnose";
import { createSolver, type SolverResult } from "./solver";
import { solverInputFromDb } from "./solver-input";
import { planningYear } from "./verteilung";

export const EFFORTS = { schnell: 0.25, normal: 1, gruendlich: 4 } as const;
export type Effort = keyof typeof EFFORTS;

/** Was zu einem Lauf gespeichert wird: Ergebnis + was die Vorschau und die Übernahme brauchen. */
export interface StoredResult {
  result: SolverResult;
  units: { id: string; label: string; groupIds: string[]; teacherIds: string[]; subjectId: string; length: 1 | 2 }[];
  keptLessonIds: string[];
  refYmd: string;
}

export interface SolverRun {
  id: string;
  status: "running" | "done" | "failed" | "applied";
  progress: number;
  seed: number;
  iterations: number;
  error: string | null;
  appliedFrom: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  stored: StoredResult | null;
}

const toRun = (r: typeof timetableSolverRuns.$inferSelect): SolverRun => ({
  id: r.id,
  status: r.status,
  progress: r.progress,
  seed: r.seed,
  iterations: r.iterations,
  error: r.error,
  appliedFrom: r.appliedFrom,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
  stored: (r.result as StoredResult | null) ?? null,
});

export async function listRuns(db: Db, limit = 5): Promise<SolverRun[]> {
  return (await db.select().from(timetableSolverRuns).orderBy(desc(timetableSolverRuns.createdAt)).limit(limit)).map(toRun);
}

export async function getRun(db: Db, id: string): Promise<SolverRun | null> {
  const [r] = await db.select().from(timetableSolverRuns).where(eq(timetableSolverRuns.id, id));
  return r ? toRun(r) : null;
}

/** Legt einen Lauf an (Status „running“); ausgeführt wird er mit executeRun(). */
export async function createRun(db: Db, actorId: string, opts: { seed?: number; effort?: string }): Promise<string> {
  const year = await planningYear(db);
  if (!year) throw new ValidationError({ year: "Zuerst ein Schuljahr anlegen" });
  if ((await listRuns(db, 20)).some((r) => r.status === "running" && Date.now() - r.createdAt.getTime() < 10 * 60_000))
    throw new ValidationError({ run: "Es läuft schon eine Berechnung" });
  const seed = Number.isInteger(opts.seed) && opts.seed! > 0 ? opts.seed! : 1;
  const [row] = await db
    .insert(timetableSolverRuns)
    .values({ schoolYearId: year.id, seed, createdBy: actorId, iterations: 0 })
    .returning({ id: timetableSolverRuns.id });
  await audit(db, actorId, "stundenplan.solver.start", null, { run: row!.id, seed, effort: opts.effort ?? "normal" });
  return row!.id;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** executeRun unter der Job-Sperre „solver“: nie zwei Berechnungen gleichzeitig (auch nicht über Prozesse hinweg). */
export async function executeRunExclusive(db: Db, runId: string, todayYmd: string, effort: string = "normal"): Promise<boolean> {
  const r = await runExclusive(db, "solver", () => executeRun(db, runId, todayYmd, effort), { ttlMs: 30 * 60_000 });
  if (!r.ran) {
    await db
      .update(timetableSolverRuns)
      .set({ status: "failed", error: "Es läuft schon eine Berechnung", finishedAt: new Date() })
      .where(eq(timetableSolverRuns.id, runId));
  }
  return r.ran;
}

/** Beim Serverstart: Läufe, die beim Beenden noch rechneten, sind verloren (sie laufen im Prozess) → als abgebrochen markieren. */
export async function failInterruptedRuns(db: Db): Promise<number> {
  const rows = await db
    .update(timetableSolverRuns)
    .set({ status: "failed", error: "Abgebrochen: Der Server wurde neu gestartet", finishedAt: new Date() })
    .where(eq(timetableSolverRuns.status, "running"))
    .returning({ id: timetableSolverRuns.id });
  return rows.length;
}

/** Führt einen Lauf aus und schreibt Fortschritt und Ergebnis (auch im Hintergrund aufrufbar). */
export async function executeRun(db: Db, runId: string, todayYmd: string, effort: string = "normal"): Promise<void> {
  const set = (v: Partial<typeof timetableSolverRuns.$inferInsert>) => db.update(timetableSolverRuns).set(v).where(eq(timetableSolverRuns.id, runId));
  try {
    const run = await getRun(db, runId);
    const year = await planningYear(db);
    if (!run || !year) throw new Error("Lauf oder Schuljahr fehlt");
    const input = await solverInputFromDb(db, year, todayYmd, { seed: run.seed });
    await set({ progress: 10 });
    const solver = createSolver(input);
    solver.construct();
    // Gründlichkeit: Anzahl der Verbesserungsschritte
    const factor = EFFORTS[(effort in EFFORTS ? effort : "normal") as Effort];
    const steps = Math.max(1, Math.round(solver.total * factor));
    await set({ progress: 30, iterations: steps });
    const chunk = 2000;
    let done = 0;
    while (done < steps) {
      solver.improve(Math.min(chunk, steps - done));
      done += chunk;
      await set({ progress: 30 + Math.min(65, Math.round((Math.min(done, steps) / steps) * 65)) });
      await tick();
    }
    const result = solver.result();
    const stored: StoredResult = {
      result,
      units: input.units.map((u) => ({ id: u.id, label: u.label, groupIds: u.groupIds, teacherIds: u.teacherIds, subjectId: u.subjectId, length: u.length })),
      keptLessonIds: input.keptLessonIds ?? [],
      refYmd: todayYmd,
    };
    await set({ status: "done", progress: 100, result: stored, finishedAt: new Date() });
  } catch (err) {
    await set({ status: "failed", error: err instanceof Error ? err.message : String(err), finishedAt: new Date() });
  }
}

// ---------------------------------------------------------------- Vorschau

export interface ProposedLesson {
  /** gemeinsam für alle Zeilen einer Einheit (Kopplung) */
  unitId: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
  coupled: boolean;
}

/** Rein: Platzierungen → Stunden-Zeilen (Gruppen × Lehrkräfte, Doppelstunde = zwei Zeilen je Teil). */
export function proposedLessons(stored: StoredResult): ProposedLesson[] {
  const unitOf = new Map(stored.units.map((u) => [u.id, u]));
  const out: ProposedLesson[] = [];
  for (const p of stored.result.placements) {
    const u = unitOf.get(p.unitId);
    if (!u) continue;
    const teachers = u.teacherIds.length ? u.teacherIds : [null];
    const coupled = u.groupIds.length * teachers.length > 1;
    for (let k = 0; k < u.length; k++)
      for (const g of u.groupIds)
        for (const t of teachers)
          out.push({
            unitId: `${u.id}@${k}`,
            groupId: g,
            subjectId: u.subjectId,
            teacherId: t,
            roomId: p.roomId,
            weekday: p.weekday,
            periodNr: p.periodNr + k,
            coupled,
          });
  }
  return out;
}

/** Diagnose des Vorschlags (Hohlstunden, Fach mehrfach am Tag, Räume) inklusive der Stunden, die bleiben. */
export async function proposalDiagnosis(db: Db, stored: StoredResult): Promise<Finding[]> {
  const kept = stored.keptLessonIds.length ? await db.select().from(timetableLessons).where(inArray(timetableLessons.id, stored.keptLessonIds)) : [];
  const lessons: DiagLesson[] = [
    ...proposedLessons(stored).map((l, i) => ({ ...l, id: `p${i}`, couplingId: l.coupled ? l.unitId : null, week: "all" as const })),
    ...kept.map((l) => ({
      id: l.id,
      couplingId: l.couplingId,
      groupId: l.groupId,
      subjectId: l.subjectId,
      teacherId: l.teacherId,
      roomId: l.roomId,
      weekday: l.weekday,
      periodNr: l.periodNr,
      week: l.week,
    })),
  ];
  const [periodRows, groupRows, sizes, teacherRows, subjectRows, roomRows] = await Promise.all([
    db.select({ nr: periods.nr }).from(periods).orderBy(periods.nr),
    db.select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel }).from(groups),
    db.select({ groupId: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.role, "member")),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")),
    db.select({ id: subjects.id, name: subjects.name, roomKind: subjects.roomKind }).from(subjects),
    db.select({ id: rooms.id, kind: rooms.kind, capacity: rooms.capacity, active: rooms.active }).from(rooms),
  ]);
  const sizeOf = new Map<string, number>();
  for (const s of sizes) sizeOf.set(s.groupId, (sizeOf.get(s.groupId) ?? 0) + 1);
  return diagnose({
    lessons,
    periods: periodRows.map((p) => p.nr),
    groups: groupRows.map((g) => ({ ...g, size: sizeOf.get(g.id) ?? 0 })),
    teachers: teacherRows,
    subjects: subjectRows,
    rooms: roomRows,
    distribution: { assignments: [], unmatched: [], curriculum: new Map() },
    accounts: [],
  }).filter((f) => f.category === "gaps" || f.category === "subjectDay" || f.category === "room");
}

// ---------------------------------------------------------------- Übernehmen

/**
 * Übernimmt den Vorschlag ab `fromYmd`: alle übrigen Stunden des Schuljahres (nicht fixiert, mit Lehrauftrag) enden am
 * Vortag bzw. werden gelöscht, wenn sie erst danach beginnen; Vertretungen ab dem Stichtag an diesen Stunden entfallen.
 * Die vorgeschlagenen Stunden gelten ab dem Stichtag bis zum Schuljahresende.
 */
export async function applyRun(
  db: Db,
  actorId: string,
  runId: string,
  fromYmd: string,
  todayYmd: string,
): Promise<{ created: number; ended: number; removedSubstitutions: number }> {
  const run = await getRun(db, runId);
  if (!run || run.status !== "done" || !run.stored) throw new ValidationError({ run: "Nur ein fertiger, noch nicht übernommener Lauf lässt sich übernehmen" });
  const year = await planningYear(db);
  if (!year) throw new ValidationError({ run: "Kein Schuljahr" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || fromYmd <= todayYmd) throw new ValidationError({ from: "Der Stichtag muss in der Zukunft liegen" });
  if (fromYmd < year.startsOn || fromYmd > year.endsOn) throw new ValidationError({ from: "Der Stichtag muss im Schuljahr liegen" });
  if (run.stored.result.unplaced.length)
    throw new ValidationError({ run: `${run.stored.result.unplaced.length} Stunden ließen sich nicht setzen – erst Lehraufträge oder Sperrzeiten anpassen` });
  const kept = new Set(run.stored.keptLessonIds);
  const proposal = proposedLessons(run.stored);
  const dayBefore = addDays(fromYmd, -1);

  const out = await db.transaction(async (tx) => {
    const current = (
      await tx
        .select()
        .from(timetableLessons)
        .where(and(lte(timetableLessons.validFrom, year.endsOn), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, fromYmd))))
    ).filter((l) => !l.fixed && !kept.has(l.id));
    const ids = current.map((l) => l.id);
    let removedSubstitutions = 0;
    if (ids.length) {
      removedSubstitutions = (
        await tx
          .delete(timetableSubstitutions)
          .where(and(inArray(timetableSubstitutions.lessonId, ids), gte(timetableSubstitutions.date, fromYmd)))
          .returning({ id: timetableSubstitutions.id })
      ).length;
      const later = current.filter((l) => l.validFrom >= fromYmd).map((l) => l.id);
      const running = current.filter((l) => l.validFrom < fromYmd).map((l) => l.id);
      if (later.length) await tx.delete(timetableLessons).where(inArray(timetableLessons.id, later));
      if (running.length) await tx.update(timetableLessons).set({ validUntil: dayBefore }).where(inArray(timetableLessons.id, running));
    }
    const couplings = new Map<string, string>();
    const rows = proposal.map((l) => {
      let couplingId: string | null = null;
      if (l.coupled) {
        if (!couplings.has(l.unitId)) couplings.set(l.unitId, crypto.randomUUID());
        couplingId = couplings.get(l.unitId)!;
      }
      return {
        groupId: l.groupId,
        subjectId: l.subjectId,
        teacherId: l.teacherId,
        roomId: l.roomId,
        weekday: l.weekday,
        periodNr: l.periodNr,
        week: "all" as const,
        validFrom: fromYmd,
        validUntil: year.endsOn,
        couplingId,
      };
    });
    for (let i = 0; i < rows.length; i += 500) await tx.insert(timetableLessons).values(rows.slice(i, i + 500));
    await tx.update(timetableSolverRuns).set({ status: "applied", appliedFrom: fromYmd }).where(eq(timetableSolverRuns.id, runId));
    return { created: rows.length, ended: ids.length, removedSubstitutions };
  });
  await audit(db, actorId, "stundenplan.solver.apply", null, { run: runId, from: fromYmd, ...out });
  return out;
}

/** Stunde (bzw. alle Teile ihrer Kopplung) fixieren oder lösen. */
export async function setFixed(db: Db, actorId: string, lessonId: string, fixed: boolean): Promise<void> {
  const [l] = await db.select().from(timetableLessons).where(eq(timetableLessons.id, lessonId));
  if (!l) throw new ValidationError({ id: "Stunde gibt es nicht" });
  await db
    .update(timetableLessons)
    .set({ fixed })
    .where(l.couplingId ? eq(timetableLessons.couplingId, l.couplingId) : eq(timetableLessons.id, lessonId));
  await audit(db, actorId, fixed ? "stundenplan.lesson.fix" : "stundenplan.lesson.unfix", l.groupId, { lesson: lessonId });
}
