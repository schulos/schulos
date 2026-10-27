// SP3-LA: Lehraufträge schnell anlegen – Matrix Klasse × Fach (`/planung/unterricht?ansicht=matrix`). Laden, Speichern (zellweise oder
// gesammelt) und Übernahme aus dem Vorhalbjahr/Vorjahr (F-10-7: Klassen über `class_map`, „Lehrkraft folgt der Klasse“ als Vorschlag;
// Kurse und Bänder nicht). Speichern läuft über create/update/deleteAssignment – dieselben Prüfungen und dasselbe Audit wie das Formular.
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { gradeLevels, groups, schoolYears, schoolYearTransitions, subjects, users } from "@/core/db/schema";
import { addDays, isCalendarDate } from "@/core/time";
import { promotedName } from "@/modules/verwaltung/schuljahreswechsel";
import { ValidationError } from "@/modules/verwaltung/users";
import { checkSubjectFit } from "./lehrfaecher";
import {
  buildMatrix,
  cellKey,
  editKind,
  gapAround,
  oneToOne,
  reconstructClassMap,
  suggestFrom,
  type Matrix,
  type MatrixEdit,
  type PreviousAssignment,
  type Suggestion,
} from "./matrix-rechnung";
import { activeOn, createAssignment, deleteAssignment, listAssignments, updateAssignment, type Assignment, type Distribution } from "./verteilung";

export * from "./matrix-rechnung";

type Year = { id: string; name: string; startsOn: string; endsOn: string; term2StartsOn: string | null };

/** Klassen der Verteilung (nur Klassen – Kurse, AGs usw. bleiben in der Listen-Ansicht) */
export function matrixClasses(d: Pick<Distribution, "groups">) {
  return d.groups.filter((g) => g.kind === "klasse").map((g) => ({ id: g.id, name: g.name, gradeLevel: g.gradeLevel }));
}

/** Jahrgänge der Klassen (Filter der Matrix); `null` = Klassen ohne Jahrgang */
export function matrixGrades(classes: readonly { gradeLevel: number | null }[]): (number | null)[] {
  const set = new Set(classes.map((c) => c.gradeLevel));
  return [...set].sort((a, b) => (a ?? 999) - (b ?? 999));
}

/** Matrix eines Jahrgangs am Stichtag der Verteilung. */
export async function loadMatrix(db: Db, d: Distribution, grade: number | null, extraSubjects: readonly string[] = []): Promise<Matrix> {
  const subjectRows = await db.select({ id: subjects.id, name: subjects.name, color: subjects.color }).from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.name));
  return buildMatrix({
    classes: matrixClasses(d).filter((c) => c.gradeLevel === grade),
    subjects: subjectRows,
    curriculum: d.curriculum,
    assignments: d.assignments,
    extraSubjects,
  });
}

// ---------------------------------------------------------------- Übernahme

/** Vorjahr: das jüngste Schuljahr, das vor dem Beginn von `year` endet. */
export async function previousYear(db: Db, year: Pick<Year, "startsOn">) {
  const rows = await db.select().from(schoolYears).where(lt(schoolYears.endsOn, year.startsOn)).orderBy(asc(schoolYears.endsOn));
  return rows.at(-1) ?? null;
}

/**
 * Klassen-Zuordnung Vorjahr → `year`: gespeicherte `class_map` des Schuljahreswechsels (nur 1:1 – zusammengelegte Klassen folgen nicht);
 * ohne sie (Übergang vor SP3-LA oder ohne Assistent) über die Namensregel `promotedName()`, soweit eindeutig.
 */
export async function classMapFor(db: Db, fromYearId: string, toYearId: string): Promise<{ map: Map<string, string>; reconstructed: boolean }> {
  const [t] = await db
    .select({ classMap: schoolYearTransitions.classMap })
    .from(schoolYearTransitions)
    .where(and(eq(schoolYearTransitions.fromYearId, fromYearId), eq(schoolYearTransitions.toYearId, toYearId)));
  if (t?.classMap) return { map: oneToOne(t.classMap), reconstructed: false };
  const [levels, olds, news] = await Promise.all([
    db.select().from(gradeLevels).orderBy(asc(gradeLevels.level)),
    db.select({ id: groups.id, name: groups.name, gradeLevel: groups.gradeLevel }).from(groups).where(and(eq(groups.schoolYearId, fromYearId), eq(groups.kind, "klasse"))),
    db.select({ id: groups.id, name: groups.name }).from(groups).where(and(eq(groups.schoolYearId, toYearId), eq(groups.kind, "klasse"))),
  ]);
  const promoted = (name: string, level: number) => {
    const from = levels.find((l) => l.level === level);
    const to = from ? levels.find((l) => l.level > from.level) : undefined;
    return from && to ? promotedName(name, from, to) : null;
  };
  return { map: reconstructClassMap(olds, news, promoted), reconstructed: true };
}

const toPrevious = (a: Assignment): PreviousAssignment => ({
  groupId: a.groups[0]?.id ?? "",
  subjectId: a.subjectId,
  hours: a.hours,
  teacherIds: a.teachers.map((t) => t.id),
  bandId: a.bandId,
});

export type SuggestionSource = "vorjahr" | "halbjahr";

export interface SuggestionResult {
  suggestions: Suggestion[];
  /** Erklärung der Quelle für die Anzeige */
  label: string;
  /** Quelle fehlt (kein Vorjahr, Stichtag nicht im 2. Halbjahr) */
  missing?: string;
  /** Vorjahr: Zuordnung über die Namensregel rekonstruiert */
  reconstructed?: boolean;
}

async function lookup(db: Db, groupIds: string[], teacherIds: string[]) {
  const [gs, ts] = await Promise.all([
    groupIds.length ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds)) : Promise.resolve([]),
    teacherIds.length
      ? db.select({ id: users.id, code: users.shortCode, name: users.name, status: users.status }).from(users).where(inArray(users.id, teacherIds))
      : Promise.resolve([]),
  ]);
  return {
    groupName: new Map(gs.map((g) => [g.id, g.name])),
    teacherCode: new Map(ts.map((t) => [t.id, t.code ?? t.name])),
    active: new Set(ts.filter((t) => t.status === "active").map((t) => t.id)),
  };
}

/**
 * Vorschläge für leere Zellen der Matrix. `halbjahr`: im 2. Halbjahr die Lehraufträge, die am letzten Tag des 1. Halbjahrs galten und am
 * Stichtag nicht mehr (gleiche Klasse). `vorjahr`: Lehraufträge des Vorjahrs am letzten Tag des Vorjahrs, Klassen über `classMapFor`.
 */
export async function matrixSuggestions(db: Db, year: Year, refYmd: string, matrix: Matrix, source: SuggestionSource): Promise<SuggestionResult> {
  if (source === "halbjahr") {
    const term2 = year.term2StartsOn;
    if (!term2 || term2 <= year.startsOn || refYmd < term2) return { suggestions: [], label: "aus dem 1. Halbjahr", missing: "Der Stichtag liegt nicht im 2. Halbjahr." };
    const lastOfTerm1 = addDays(term2, -1);
    const prev = (await listAssignments(db, year.id)).filter((a) => activeOn(a, lastOfTerm1) && !activeOn(a, refYmd)).map(toPrevious);
    const identity = new Map(matrix.rows.map((r) => [r.groupId, r.groupId]));
    const names = await lookup(db, [...new Set(prev.map((p) => p.groupId))], [...new Set(prev.flatMap((p) => p.teacherIds))]);
    return { suggestions: suggestFrom(prev, identity, matrix, names), label: "aus dem 1. Halbjahr" };
  }
  const before = await previousYear(db, year);
  if (!before) return { suggestions: [], label: "aus dem Vorjahr", missing: "Es gibt kein Vorjahr." };
  const [{ map, reconstructed }, list] = await Promise.all([classMapFor(db, before.id, year.id), listAssignments(db, before.id)]);
  const prev = list.filter((a) => activeOn(a, before.endsOn)).map(toPrevious);
  const names = await lookup(db, [...new Set(prev.map((p) => p.groupId))], [...new Set(prev.flatMap((p) => p.teacherIds))]);
  return { suggestions: suggestFrom(prev, map, matrix, names), label: `aus dem Schuljahr ${before.name}`, reconstructed };
}

// ---------------------------------------------------------------- Speichern

export interface MatrixSaveResult {
  key: string;
  ok: boolean;
  error?: string;
  /** fachfremd ohne „Trotzdem zuweisen“ – die Zelle zeigt das Häkchen */
  needsConfirm?: boolean;
}

export const MAX_MATRIX_EDITS = 400;

/** Eingaben aus dem Browser prüfen (Server Action bekommt beliebige Werte). */
export function parseEdits(raw: unknown): MatrixEdit[] {
  if (!Array.isArray(raw) || raw.length > MAX_MATRIX_EDITS) throw new ValidationError({ edits: `höchstens ${MAX_MATRIX_EDITS} Änderungen auf einmal` });
  const str = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : null);
  return raw.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const groupId = str(o.groupId);
    const subjectId = str(o.subjectId);
    if (!groupId || !subjectId) throw new ValidationError({ edits: "Zelle unbekannt" });
    return {
      groupId,
      subjectId,
      assignmentId: str(o.assignmentId) || null,
      teacherId: str(o.teacherId) || null,
      hours: typeof o.hours === "number" ? o.hours : Number.NaN,
      offSubjectOk: str(o.offSubjectOk) || null,
    };
  });
}

/**
 * Speichert Änderungen aus der Matrix, je Zelle einzeln (eine fehlerhafte Zelle hält die anderen nicht auf). Neu angelegte Lehraufträge
 * füllen die Lücke am Stichtag (`gapAround`), bestehende behalten Raum, Hinweis, Gültigkeit und Doppelstunden (höchstens Stunden/2).
 * Stunden 0 löschen den Lehrauftrag der Zelle. Audit je Lehrauftrag wie im Formular, dazu eine Zusammenfassung mit Anzahlen.
 */
export async function saveMatrixEdits(
  db: Db,
  actorId: string,
  year: Pick<Year, "id" | "startsOn" | "endsOn">,
  refYmd: string,
  edits: readonly MatrixEdit[],
  source: "matrix" | SuggestionSource = "matrix",
): Promise<MatrixSaveResult[]> {
  if (!isCalendarDate(refYmd) || refYmd < year.startsOn || refYmd > year.endsOn) throw new ValidationError({ refYmd: "Stichtag liegt nicht im Schuljahr" });
  const all = await listAssignments(db, year.id);
  const byId = new Map(all.map((a) => [a.id, a]));
  const inCell = (e: Pick<MatrixEdit, "groupId" | "subjectId">) => all.filter((a) => a.subjectId === e.subjectId && a.groups.some((g) => g.id === e.groupId));
  const last = new Map<string, MatrixEdit>();
  for (const e of edits) last.set(cellKey(e.groupId, e.subjectId), e);
  const counts = { created: 0, updated: 0, deleted: 0, failed: 0 };
  const results: MatrixSaveResult[] = [];
  for (const [key, e] of last) {
    try {
      if (!Number.isInteger(e.hours) || e.hours < 0 || e.hours > 12) throw new ValidationError({ hours: "0 bis 12 Wochenstunden (0 = kein Lehrauftrag)" });
      const kind = editKind(e);
      if (kind === "none") {
        results.push({ key, ok: true });
        continue;
      }
      const cell = inCell(e);
      const current = cell.filter((a) => activeOn(a, refYmd));
      if (kind === "create") {
        if (current.length) throw new ValidationError({ cell: "Die Zelle hat inzwischen einen Lehrauftrag – Seite neu laden" });
      } else {
        const a = byId.get(e.assignmentId!);
        if (!a || !cell.includes(a) || !activeOn(a, refYmd)) throw new ValidationError({ cell: "Lehrauftrag gibt es so nicht mehr – Seite neu laden" });
        if (a.bandId || a.teachers.length > 1 || current.length > 1) throw new ValidationError({ cell: "Band oder Teamteaching – im Formular bearbeiten" });
      }
      if (kind === "delete") {
        await deleteAssignment(db, actorId, e.assignmentId!);
        counts.deleted++;
        results.push({ key, ok: true });
        continue;
      }
      const teacherIds = e.teacherId ? [e.teacherId] : [];
      const off = await checkSubjectFit(db, e.subjectId, teacherIds, !!e.teacherId && e.offSubjectOk === e.teacherId);
      if (kind === "create") {
        const gap = gapAround(refYmd, cell.filter((a) => !activeOn(a, refYmd)));
        await createAssignment(db, actorId, {
          schoolYearId: year.id,
          groupId: e.groupId,
          subjectId: e.subjectId,
          hours: e.hours,
          teacherIds,
          doubleLessons: 0,
          roomId: null,
          note: null,
          bandId: null,
          validFrom: gap.validFrom,
          validUntil: gap.validUntil,
        });
        counts.created++;
      } else {
        const a = byId.get(e.assignmentId!)!;
        if (a.hours === e.hours && (a.teachers[0]?.id ?? null) === e.teacherId) {
          results.push({ key, ok: true });
          continue;
        }
        await updateAssignment(db, actorId, a.id, {
          schoolYearId: year.id,
          groupId: e.groupId,
          subjectId: e.subjectId,
          hours: e.hours,
          teacherIds,
          doubleLessons: Math.min(a.doubleLessons, Math.floor(e.hours / 2)),
          roomId: a.roomId,
          note: a.note,
          validFrom: a.validFrom,
          validUntil: a.validUntil,
        });
        counts.updated++;
      }
      if (off.length) await audit(db, actorId, "stundenplan.assignment.off_subject", e.groupId, { subject: e.subjectId, teachers: off });
      results.push({ key, ok: true });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      counts.failed++;
      const msg = Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen";
      results.push({ key, ok: false, error: msg, needsConfirm: /Trotzdem zuweisen/.test(msg) || undefined });
    }
  }
  if (counts.created + counts.updated + counts.deleted > 0) await audit(db, actorId, "stundenplan.assignment.matrix", null, { ...counts, source });
  return results;
}
