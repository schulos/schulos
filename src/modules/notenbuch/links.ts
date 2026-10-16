// Notenbuch (P5-16): Verknüpfungen – Startseiten-Widget, Kursraum und Suche zeigen **nur eigene** Notenbücher (die Person ist
// als Lehrkraft im Buch eingetragen und hat `notenbuch.own` ausdrücklich). Nie Noten, Vorschläge oder Kommentare, keine Statistik
// über Lehrkräfte und nichts aus fremden Büchern – auch nicht für Schulleitung, `term_view` oder Admin-Konten (kein Override).
// Gezeigt werden nur Lerngruppe, Fach, Halbjahr, Sperre und für das Widget die Zahl der eigenen Lernenden ohne festgelegte
// Halbjahresnote. Geöffnet wird das Buch weiter über das Layout (2FA-Pflicht, Datenschutzhinweis, Inaktivitätsablauf).
import { and, eq, ilike, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { groupMembers, groups, notenbuchBooks, notenbuchBookTeachers, notenbuchTermGrades, schoolYears, subjects, users } from "@/core/db/schema";
import { accessBlocked, type PermissionSet } from "@/core/permissions";
import { hasNotenbuchRight, OWN } from "./service";

export interface OwnBookLink {
  id: string;
  groupId: string;
  groupName: string;
  subjectName: string;
  schoolYearName: string;
  term: number;
  locked: boolean;
  /** Buch des laufenden Schuljahres (`is_current`) */
  current: boolean;
}

export interface OwnBookFilter {
  /** nur Bücher dieser Lerngruppe (Kursraum) */
  groupId?: string;
  /** Suchbegriff über Lerngruppe und Fach */
  q?: string;
  /** nur Bücher des laufenden Schuljahres */
  currentOnly?: boolean;
  limit?: number;
}

/** Darf die Person eigene Notenbücher überhaupt führen? (ausdrückliches `notenbuch.own`, Konto nicht gesperrt) */
export function canOwnBooks(perms: PermissionSet): boolean {
  return !accessBlocked(perms) && hasNotenbuchRight(perms, OWN);
}

const likeOf = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

/** Eigene Notenbücher (nur Kopfdaten, keine Noten) – laufendes Schuljahr zuerst, dann Lerngruppe, Fach, Halbjahr. */
export async function ownBookLinks(db: Db, perms: PermissionSet, filter: OwnBookFilter = {}): Promise<OwnBookLink[]> {
  if (!canOwnBooks(perms)) return [];
  const where: SQL[] = [eq(notenbuchBookTeachers.teacherId, perms.userId)];
  if (filter.groupId) where.push(eq(notenbuchBooks.groupId, filter.groupId));
  if (filter.currentOnly) where.push(eq(schoolYears.isCurrent, true));
  if (filter.q) where.push(or(ilike(groups.name, likeOf(filter.q)), ilike(subjects.name, likeOf(filter.q)), ilike(subjects.id, likeOf(filter.q)))!);
  const rows = await db
    .select({
      id: notenbuchBooks.id,
      groupId: notenbuchBooks.groupId,
      groupName: groups.name,
      subjectName: subjects.name,
      schoolYearName: schoolYears.name,
      yearStart: schoolYears.startsOn,
      current: schoolYears.isCurrent,
      term: notenbuchBooks.term,
      lockedAt: notenbuchBooks.lockedAt,
    })
    .from(notenbuchBookTeachers)
    .innerJoin(notenbuchBooks, eq(notenbuchBooks.id, notenbuchBookTeachers.bookId))
    .innerJoin(groups, eq(groups.id, notenbuchBooks.groupId))
    .innerJoin(subjects, eq(subjects.id, notenbuchBooks.subjectId))
    .innerJoin(schoolYears, eq(schoolYears.id, notenbuchBooks.schoolYearId))
    .where(and(...where))
    .orderBy(de(groups.name), de(subjects.name), notenbuchBooks.term);
  const sorted = rows
    .sort((a, b) => (a.yearStart === b.yearStart ? 0 : a.yearStart < b.yearStart ? 1 : -1))
    .map((r) => ({
      id: r.id,
      groupId: r.groupId,
      groupName: r.groupName,
      subjectName: r.subjectName,
      schoolYearName: r.schoolYearName,
      term: r.term,
      locked: r.lockedAt !== null,
      current: r.current,
    }));
  return filter.limit ? sorted.slice(0, filter.limit) : sorted;
}

/**
 * Für das Widget: je eigenem Buch die Zahl der Schüler:innen der Lerngruppe **ohne festgelegte Halbjahresnote** – nur eine Anzahl
 * für die eigene Arbeit, keine Noten und keine Namen. Abgeschlossene Bücher zählen 0.
 */
export async function openTermGrades(db: Db, books: readonly Pick<OwnBookLink, "id" | "groupId" | "locked">[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const open = books.filter((b) => !b.locked);
  for (const b of books) out.set(b.id, 0);
  if (open.length === 0) return out;
  const groupIds = [...new Set(open.map((b) => b.groupId))];
  const [members, finals] = await Promise.all([
    db
      .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(inArray(groupMembers.groupId, groupIds), eq(users.role, "schueler"))),
    db
      .select({ bookId: notenbuchTermGrades.bookId, studentId: notenbuchTermGrades.studentId })
      .from(notenbuchTermGrades)
      .where(
        and(
          inArray(
            notenbuchTermGrades.bookId,
            open.map((b) => b.id),
          ),
          isNotNull(notenbuchTermGrades.final),
        ),
      ),
  ]);
  const finalSet = new Set(finals.map((f) => `${f.bookId}:${f.studentId}`));
  for (const b of open) out.set(b.id, members.filter((m) => m.groupId === b.groupId && !finalSet.has(`${b.id}:${m.userId}`)).length);
  return out;
}
