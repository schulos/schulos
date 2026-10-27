// SP3-01 (docs/STUNDENPLAN-LEBENSZYKLUS.md §0 Kernentscheidung B, §3.1): eine „Planquelle“ für Lader und Schreiber – der gültige Plan
// am Stichtag (`timetable_lessons`) oder der Entwurf einer Planversion (`timetable_draft_lessons`). `lessonTable()` ist der **einzige**
// Zugang für die Wahl gültig/Entwurf; die Prüflogik (Diagnose, Setzhilfe, Solver) arbeitet weiter auf Zeilenlisten. Die Lader der
// Setzhilfe/Diagnose/Solver-Eingabe stellt SP3-02 darauf um – bis dahin lesen sie unverändert den gültigen Plan.
import { and, eq, gte, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableDraftLessons, timetableLessons } from "./schema";

/** Quelle eines Plans: gültig am Stichtag oder Entwurf einer Version. */
export type PlanSource = { kind: "live"; refYmd: string } | { kind: "draft"; versionId: string };

/** Gemeinsame Zeilenform beider Tabellen (Spalten aus `lessonColumns()`); Entwurfsfelder nur bei `draft`. */
export interface PlanLessonRow {
  id: string;
  groupId: string;
  weekday: number;
  periodNr: number;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  week: "all" | "A" | "B";
  validFrom: string;
  validUntil: string | null;
  couplingId: string | null;
  fixed: boolean;
  solverRunId: string | null;
  /** nur Entwurf: Herkunft im gültigen Plan */
  originLessonId?: string | null;
}

/** Fachliche Felder einer Stunde (ohne id, Anlagezeitpunkt und Entwurfs-/Herkunftsfelder) – zum Kopieren zwischen den Tabellen. */
export type LessonFields = Omit<PlanLessonRow, "id" | "originLessonId">;

export function lessonFields(r: LessonFields): LessonFields {
  return {
    groupId: r.groupId,
    weekday: r.weekday,
    periodNr: r.periodNr,
    subjectId: r.subjectId,
    teacherId: r.teacherId,
    roomId: r.roomId,
    week: r.week,
    validFrom: r.validFrom,
    validUntil: r.validUntil,
    couplingId: r.couplingId,
    fixed: r.fixed,
    solverRunId: r.solverRunId,
  };
}

/** Die Tabelle einer Quelle – beide haben dieselben Spalten (gemeinsame Spaltenfabrik in schema.ts). */
export function lessonTable(source: PlanSource): typeof timetableLessons | typeof timetableDraftLessons {
  return source.kind === "live" ? timetableLessons : timetableDraftLessons;
}

/** Bedingung „gehört zur Quelle“: gültig am Stichtag (Überlappung) bzw. Stunde der Version. */
export function sourceWhere(source: PlanSource): SQL {
  if (source.kind === "draft") return eq(timetableDraftLessons.versionId, source.versionId);
  return and(lte(timetableLessons.validFrom, source.refYmd), or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, source.refYmd)))!;
}

/** Alle Stunden einer Quelle (gültiger Plan: die am Stichtag gelten; Entwurf: alle Stunden der Version). */
export async function planLessons(db: Db, source: PlanSource): Promise<PlanLessonRow[]> {
  if (source.kind === "draft") {
    const rows = await db.select().from(timetableDraftLessons).where(sourceWhere(source));
    return rows.map((r) => ({ id: r.id, ...lessonFields(r), originLessonId: r.originLessonId }));
  }
  const rows = await db.select().from(timetableLessons).where(sourceWhere(source));
  return rows.map((r) => ({ id: r.id, ...lessonFields(r) }));
}

/** Kennzahlen einer Quelle für die Versionskarte. */
export interface PlanFigures {
  lessons: number;
  groups: number;
  teachers: number;
  rooms: number;
  /** Stunden ohne Lehrkraft */
  withoutTeacher: number;
}

export function planFigures(rows: readonly PlanLessonRow[]): PlanFigures {
  const count = (pick: (r: PlanLessonRow) => string | null) => new Set(rows.map(pick).filter((x): x is string => x !== null)).size;
  return {
    lessons: rows.length,
    groups: count((r) => r.groupId),
    teachers: count((r) => r.teacherId),
    rooms: count((r) => r.roomId),
    withoutTeacher: rows.filter((r) => r.teacherId === null).length,
  };
}
