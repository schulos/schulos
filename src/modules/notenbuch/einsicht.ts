// Notenbuch (P5-14): Schüler-/Elternsicht als Moduleinstellung (F5-06, Vorgabe aus) – reine Lesesicht auf die **eigenen** Noten.
//   · Schüler:innen (auch eigenständige) sehen nur sich selbst, Eltern nur verknüpfte Kinder, die sie sehen dürfen
//     (`parentInformedSql`: minderjährig oder Einwilligung der eigenständigen Person) und deren Jahrgang die Einstellung umfasst
//     (Sek I, die Oberstufe nie). Fremde Kinder und alle anderen Rollen: nichts (`null`, wie nicht vorhanden).
//   · Umfang je Einstellung: Halbjahresnote erst nach dem Abschluss des Buchs (festgelegt + gesperrt); bei „Teilnoten“ zusätzlich
//     die eingetragenen Teilnoten mit Titel, Art und Datum der Leistung. **Nie** Kommentare, Gewichte, Vorschläge, Fehlstunden
//     oder Noten anderer (Q-5A-15).
//   · Keine Zwei-Faktor-Pflicht und kein Inaktivitätsablauf für diese Sicht (eigene Daten wie Fehlzeiten/Stundenplan), kein
//     Lese-Protokoll (Q-5A-16).
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import {
  groups,
  notenbuchBooks,
  notenbuchColumns,
  notenbuchEntries,
  notenbuchTermGrades,
  parentChild,
  schoolYears,
  subjects,
  users,
} from "@/core/db/schema";
import { readGradeSetting, readModuleSetting } from "@/core/modules/settings";
import { accessBlocked, type PermissionSet } from "@/core/permissions";
import { sek1GradeOf, withinGradeSetting } from "@/core/school/grades";
import { parentInformedSql } from "@/core/school/majority";
import { COLUMN_KIND_LABELS, defaultKey, gradeFromPoints, SPECIAL_VALUES, type ColumnKind } from "./berechnung";
import { PARENTS_VIEW, STUDENT_VIEW } from "./settings";

export type FamilyScope = "aus" | "halbjahr" | "teilnoten";

/** Umfang der Schüler-/Elternsicht laut Einstellung. */
export async function familyScope(db: Db): Promise<FamilyScope> {
  return (await readModuleSetting(db, STUDENT_VIEW)) as FamilyScope;
}

/**
 * Wessen Noten die Person sehen darf: Schüler:innen sich selbst, Eltern ihre Kinder nach Einstellung und Jahrgang. Sonst leer
 * (auch Lehrkräfte – die arbeiten im Notenbuch selbst).
 */
export async function gradeOwners(db: Db, perms: PermissionSet): Promise<{ id: string; name: string }[]> {
  if (accessBlocked(perms) || (perms.role !== "schueler" && perms.role !== "eltern")) return [];
  if ((await familyScope(db)) === "aus") return [];
  if (perms.role === "schueler") {
    const [me] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, perms.userId));
    return me ? [me] : [];
  }
  const max = await readGradeSetting(db, PARENTS_VIEW);
  if (max === 0) return [];
  const children = await db
    .select({ id: users.id, name: users.name })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .where(and(eq(parentChild.parentId, perms.userId), eq(users.role, "schueler"), parentInformedSql()))
    .orderBy(de(users.firstName));
  const grades = await sek1GradeOf(
    db,
    children.map((c) => c.id),
  );
  return children.filter((c) => withinGradeSetting(grades.get(c.id), max));
}

export interface FamilyGrade {
  title: string;
  kind: string;
  date: string | null;
  /** angezeigter Wert: Note, „fehlt“/„befreit“, bei Punkte-Spalten „34 von 40 Punkten → 1“ */
  display: string;
}

export interface FamilyBook {
  bookId: string;
  subjectName: string;
  groupName: string;
  schoolYearName: string;
  term: number;
  /** abgeschlossen: erst dann erscheint die Halbjahresnote */
  closed: boolean;
  final: string | null;
  /** nur bei Umfang „teilnoten“ */
  grades: FamilyGrade[];
}

export interface FamilyView {
  student: { id: string; name: string };
  scope: Exclude<FamilyScope, "aus">;
  books: FamilyBook[];
}

const fmtPoints = (n: number) => String(n).replace(".", ",");

/** Rein: Anzeige einer Teilnote (Note bzw. Punkte mit Note aus dem Schlüssel). */
export function displayEntry(value: string, scale: Parameters<typeof defaultKey>[0], column: { maxPoints: number | null; key: readonly { min: number; grade: string }[] | null }): string {
  if ((SPECIAL_VALUES as readonly string[]).includes(value)) return value;
  if (column.maxPoints) {
    const points = Number(value);
    const grade = gradeFromPoints(points, column.maxPoints, column.key ?? defaultKey(scale));
    return `${fmtPoints(points)} von ${fmtPoints(column.maxPoints)} Punkten → ${grade}`;
  }
  return value;
}

/**
 * Noten einer Schüler:in für die Schüler-/Elternsicht – nur, wenn die Person sie sehen darf (`gradeOwners`), sonst null.
 * Bücher, in denen die Person Noten hat, neueste Schuljahre zuerst; ohne Kommentare und Vorschläge.
 */
export async function familyGrades(db: Db, perms: PermissionSet, studentId: string): Promise<FamilyView | null> {
  const owner = (await gradeOwners(db, perms)).find((o) => o.id === studentId);
  if (!owner) return null;
  const scope = (await familyScope(db)) as Exclude<FamilyScope, "aus">;
  const [terms, entries] = await Promise.all([
    db.select({ bookId: notenbuchTermGrades.bookId, final: notenbuchTermGrades.final }).from(notenbuchTermGrades).where(eq(notenbuchTermGrades.studentId, studentId)),
    scope === "teilnoten"
      ? db
          .select({
            bookId: notenbuchColumns.bookId,
            title: notenbuchColumns.title,
            kind: notenbuchColumns.kind,
            date: notenbuchColumns.date,
            maxPoints: notenbuchColumns.maxPoints,
            key: notenbuchColumns.pointsToGrade,
            position: notenbuchColumns.position,
            value: notenbuchEntries.value,
          })
          .from(notenbuchEntries)
          .innerJoin(notenbuchColumns, eq(notenbuchColumns.id, notenbuchEntries.columnId))
          .where(eq(notenbuchEntries.studentId, studentId))
          .orderBy(asc(notenbuchColumns.position), asc(notenbuchColumns.createdAt))
      : Promise.resolve([]),
  ]);
  const bookIds = [...new Set([...terms.map((t) => t.bookId), ...entries.map((e) => e.bookId)])];
  if (!bookIds.length) return { student: owner, scope, books: [] };
  const books = await db
    .select({
      id: notenbuchBooks.id,
      scale: notenbuchBooks.scale,
      term: notenbuchBooks.term,
      lockedAt: notenbuchBooks.lockedAt,
      subjectName: subjects.name,
      groupName: groups.name,
      yearName: schoolYears.name,
      yearStart: schoolYears.startsOn,
    })
    .from(notenbuchBooks)
    .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
    .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
    .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
    .where(inArray(notenbuchBooks.id, bookIds))
    .orderBy(de(subjects.name));
  const finalOf = new Map(terms.map((t) => [t.bookId, t.final]));
  return {
    student: owner,
    scope,
    books: books
      .sort((a, b) => (a.yearStart === b.yearStart ? b.term - a.term : a.yearStart < b.yearStart ? 1 : -1))
      .map((b) => {
        const closed = b.lockedAt !== null;
        return {
          bookId: b.id,
          subjectName: b.subjectName,
          groupName: b.groupName,
          schoolYearName: b.yearName,
          term: b.term,
          closed,
          final: closed ? (finalOf.get(b.id) ?? null) : null,
          grades: entries
            .filter((e) => e.bookId === b.id)
            .map((e) => ({
              title: e.title,
              kind: COLUMN_KIND_LABELS[e.kind as ColumnKind] ?? e.kind,
              date: e.date,
              display: displayEntry(e.value, b.scale, { maxPoints: e.maxPoints, key: e.key ?? null }),
            })),
        };
      })
      .filter((b) => b.final !== null || b.grades.length > 0),
  };
}
