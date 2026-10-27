// SP3-01 (docs/STUNDENPLAN-LEBENSZYKLUS.md §0 Kernentscheidung B, §3.1): eine „Planquelle“ für Lader und Schreiber – der gültige Plan
// am Stichtag (`timetable_lessons`) oder der Entwurf einer Planversion (`timetable_draft_lessons`). `lessonTable()` ist der **einzige**
// Zugang für die Wahl gültig/Entwurf; die Prüflogik (Diagnose, Setzhilfe, Solver) arbeitet weiter auf Zeilenlisten. Seit SP3-02 laufen
// die Lader von Setzhilfe, Diagnose, Verteilung und Solver-Eingabe sowie die Schreiber der Pflege darüber (Lader: `lessonCols()` + die
// Bedingungen unten; Schreiber verzweigen ausdrücklich, R5). Leser außerhalb der Planung kennen weiter nur den gültigen Plan.
import { and, eq, gte, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { ValidationError } from "@/modules/verwaltung/users";
import { timetableDraftLessons, timetableLessons, timetablePlanVersions, type TimetablePlanVersion } from "./schema";

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

/** Der gültige Plan als Quelle (Vorgabe aller Lader und Schreiber; der Stichtag kommt bei Ladern als eigener Parameter). */
export const LIVE: PlanSource = { kind: "live", refYmd: "" };
export const draftOf = (versionId: string): PlanSource => ({ kind: "draft", versionId });
export const isDraft = (source: PlanSource | undefined): source is { kind: "draft"; versionId: string } => source?.kind === "draft";

/**
 * Spalten der Tabelle einer Quelle für Lader und Schreiber, die nur die **gemeinsamen** Spalten (`lessonColumns()`) benutzen. Beide
 * Tabellen haben dieselben Spalten-Namen und -Typen; der Typ des gültigen Plans steht hier für beide (R5: keine Typ-Verrenkungen je
 * Abfrage). Entwurfs-Spalten (`version_id`, `origin_lesson_id`, `assignment_id`) nur über `timetableDraftLessons` direkt.
 */
export function lessonCols(source: PlanSource = LIVE): typeof timetableLessons {
  return lessonTable(source) as unknown as typeof timetableLessons;
}

/** Nur Stunden dieser Quelle: im Entwurf die der Version, im gültigen Plan keine Einschränkung (Gültigkeit regelt der Aufrufer). */
export function versionWhere(source: PlanSource = LIVE): SQL | undefined {
  return source.kind === "draft" ? eq(timetableDraftLessons.versionId, source.versionId) : undefined;
}

/** Stunden der Quelle, die am Tag `ymd` gelten (Entwürfe haben dieselben Gültigkeitsspalten). */
export function activeOnWhere(source: PlanSource, ymd: string): SQL {
  const t = lessonCols(source);
  return and(versionWhere(source), lte(t.validFrom, ymd), or(isNull(t.validUntil), gte(t.validUntil, ymd)))!;
}

/** Stunden der Quelle, die sich mit dem Zeitraum `from` … `until` (leer = offen) überschneiden. */
export function overlapWhere(source: PlanSource, from: string, until: string | null): SQL {
  const t = lessonCols(source);
  return and(versionWhere(source), until ? lte(t.validFrom, until) : undefined, or(isNull(t.validUntil), gte(t.validUntil, from)))!;
}

/** Eine Stunde der Quelle (im Entwurf nur, wenn sie zur Version gehört). */
export function idWhere(source: PlanSource, id: string): SQL {
  return and(eq(lessonCols(source).id, id), versionWhere(source))!;
}

/**
 * Schreiben in eine Quelle: der gültige Plan immer (Rechte prüft die Action), ein Entwurf nur im Status `entwurf` (Prüfung/Freigabe
 * kommen mit SP3-03; dort entscheidet sich, ob eine Änderung den Status zurücksetzt). Liefert die Version bzw. `null` beim gültigen Plan.
 */
export async function requireWritable(db: Db, source: PlanSource): Promise<TimetablePlanVersion | null> {
  if (source.kind === "live") return null;
  const [v] = await db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, source.versionId));
  if (!v) throw new ValidationError({ version: "Den Entwurf gibt es nicht mehr" });
  if (v.status !== "entwurf") throw new ValidationError({ version: `Version ${v.major}.${v.minor} ist kein Entwurf mehr – nur Entwürfe lassen sich bearbeiten` });
  return v;
}

/** Zeile zum Anlegen in einer Quelle: fachliche Felder, im Entwurf optional Lehrauftrag und Herkunft. */
export type NewLessonRow = Partial<Pick<PlanLessonRow, "id" | "couplingId" | "fixed" | "solverRunId" | "week">> &
  Pick<PlanLessonRow, "groupId" | "weekday" | "periodNr" | "subjectId" | "teacherId" | "roomId" | "validFrom" | "validUntil"> & {
    assignmentId?: string | null;
    originLessonId?: string | null;
  };

/** Stunden in eine Quelle schreiben (in Blöcken); Entwurfsfelder fallen im gültigen Plan weg. Liefert die ids in Reihenfolge. */
export async function insertLessonRows(db: Db, source: PlanSource, rows: NewLessonRow[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    if (source.kind === "draft") {
      const out = await db
        .insert(timetableDraftLessons)
        .values(part.map((r) => ({ ...r, versionId: source.versionId })))
        .returning({ id: timetableDraftLessons.id });
      ids.push(...out.map((o) => o.id));
    } else {
      const out = await db
        .insert(timetableLessons)
        .values(
          part.map((r) => ({
            ...(r.id ? { id: r.id } : {}),
            groupId: r.groupId,
            weekday: r.weekday,
            periodNr: r.periodNr,
            subjectId: r.subjectId,
            teacherId: r.teacherId,
            roomId: r.roomId,
            week: r.week ?? "all",
            validFrom: r.validFrom,
            validUntil: r.validUntil,
            couplingId: r.couplingId ?? null,
            fixed: r.fixed ?? false,
            solverRunId: r.solverRunId ?? null,
          })),
        )
        .returning({ id: timetableLessons.id });
      ids.push(...out.map((o) => o.id));
    }
  }
  return ids;
}

/** Herkunft (`origin_lesson_id`) von Entwurfsstunden je id. */
export async function draftOrigins(db: Db, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 500)
    for (const o of await db
      .select({ id: timetableDraftLessons.id, origin: timetableDraftLessons.originLessonId })
      .from(timetableDraftLessons)
      .where(inArray(timetableDraftLessons.id, ids.slice(i, i + 500))))
      out.set(o.id, o.origin);
  return out;
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
