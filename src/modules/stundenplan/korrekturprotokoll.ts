// SP3-06 (offener Punkt aus SP3-05): Korrektur-Protokoll – die Sofort-Korrekturen im gültigen Plan (`timetable_plan_changes`) eines
// Schuljahrs als Liste je Aktion: wann, wer, ab wann, Begründung, welche Stunden (Zeilen wie in der Änderungsliste). Nur Lesen; nur für die
// Planung (`stundenplan.manage`), wie das Protokoll selbst (DATENSCHUTZ §3.4).
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { changeNames } from "./plan-gong";
import { changeLine } from "./plan-uebertrag";
import { versionNumber } from "./planversionen";
import { timetablePlanChanges, timetablePlanVersions, type PlanChangeKind } from "./schema";
import { changeItems, type PlanChangeLesson } from "./sofortkorrektur";
import { DELETED_TEACHER } from "./solverlauf-konto";

/** Höchstens so viele Protokoll-Zeilen (Stunden) je Seite – die neuesten zuerst. */
export const LOG_ROW_LIMIT = 1000;

export interface CorrectionBatch {
  batchId: string;
  createdAt: Date;
  actor: string | null;
  validFrom: string;
  versionLabel: string | null;
  reason: string | null;
  kinds: Record<PlanChangeKind, number>;
  /** sichtbare Änderungen als Zeilen („Mo 3. Std Mathematik (7b): Raum 106 → 105“) */
  lines: string[];
  /** Änderungsliste an Schüler:innen/Eltern: versandt bzw. geplant */
  notifiedAt: Date | null;
  notifyAt: Date | null;
}

/** Sofort-Korrekturen eines Schuljahrs, je Aktion gebündelt (neueste zuerst). */
export async function correctionLog(db: Db, schoolYearId: string): Promise<{ batches: CorrectionBatch[]; truncated: boolean }> {
  const t = timetablePlanChanges;
  const rows = await db
    .select({
      id: t.id,
      batchId: t.batchId,
      kind: t.kind,
      lessonId: t.lessonId,
      validFrom: t.validFrom,
      before: t.before,
      after: t.after,
      reason: t.reason,
      actorId: t.actorId,
      createdAt: t.createdAt,
      notifyAt: t.notifyAt,
      notifiedAt: t.notifiedAt,
      major: timetablePlanVersions.major,
      minor: timetablePlanVersions.minor,
    })
    .from(t)
    .innerJoin(timetablePlanVersions, eq(timetablePlanVersions.id, t.versionId))
    .where(eq(timetablePlanVersions.schoolYearId, schoolYearId))
    .orderBy(desc(t.createdAt), desc(t.batchId), desc(t.id))
    .limit(LOG_ROW_LIMIT + 1);
  const truncated = rows.length > LOG_ROW_LIMIT;
  const list = rows.slice(0, LOG_ROW_LIMIT);
  const actorIds = [...new Set(list.map((r) => r.actorId).filter((x): x is string => Boolean(x)))];
  const [names, actors] = await Promise.all([
    changeNames(db),
    actorIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, actorIds)) : Promise.resolve([]),
  ]);
  const teachers = new Map(names.teachers);
  teachers.set(DELETED_TEACHER, DELETED_TEACHER);
  const n = { ...names, teachers };
  const actorName = new Map(actors.map((a) => [a.id, a.name]));
  const batches = new Map<string, CorrectionBatch & { rows: typeof list }>();
  for (const r of list) {
    let b = batches.get(r.batchId);
    if (!b) {
      b = {
        batchId: r.batchId,
        createdAt: r.createdAt,
        actor: r.actorId ? (actorName.get(r.actorId) ?? null) : null,
        validFrom: r.validFrom,
        versionLabel: versionNumber(r),
        reason: r.reason,
        kinds: { split: 0, inplace: 0, delete: 0, create: 0 },
        lines: [],
        notifiedAt: r.notifiedAt,
        notifyAt: r.notifyAt,
        rows: [],
      };
      batches.set(r.batchId, b);
    }
    b.kinds[r.kind]++;
    if (r.validFrom < b.validFrom) b.validFrom = r.validFrom;
    if (!b.reason && r.reason) b.reason = r.reason;
    if (r.notifiedAt && (!b.notifiedAt || r.notifiedAt > b.notifiedAt)) b.notifiedAt = r.notifiedAt;
    b.rows.push(r);
  }
  return {
    truncated,
    batches: [...batches.values()].map(({ rows: rs, ...b }) => ({
      ...b,
      lines: changeItems(rs.map((r) => ({ kind: r.kind, lessonId: r.lessonId ?? r.id, before: r.before as PlanChangeLesson | null, after: r.after as PlanChangeLesson | null }))).map((c) => changeLine(c, n)),
    })),
  };
}
