// Hausaufgaben für Schüler:innen (Q5-02, I-01): aus den Klassenbucheinträgen der eigenen Gruppen, ohne eigene Tabelle.
// Fällig ist eine Hausaufgabe am Datum, das die Lehrkraft gesetzt hat (Q5-27, „fällig am“), sonst zur nächsten Stunde
// derselben Gruppe im selben Fach (Entfall übersprungen). Eltern sehen sie
// nur, wenn die Moduleinstellung „Hausaufgaben für Eltern sichtbar bis Jahrgang“ den Jahrgang des Kindes umfasst (F-04).
import { and, desc, eq, gte, inArray, isNotNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { classbookEntries, groupMembers, groups, parentChild, subjects, users } from "@/core/db/schema";
import { parentInformedSql } from "@/core/school/majority";
import { readGradeSetting } from "@/core/modules/settings";
import { sek1GradeOf, withinGradeSetting } from "@/core/school/grades";
import type { PermissionSet } from "@/core/permissions";
import { addDays } from "@/core/time";
import { de } from "@/core/db/sort";
import { listSlots, type LessonSlot } from "@/modules/stundenplan/service";
import { PARENTS_HOMEWORK } from "./settings";

/** so weit zurück werden Einträge gelesen (Hausaufgabe über die Ferien bzw. für die nächste Woche) */
export const HOMEWORK_LOOKBACK_DAYS = 21;
/** so weit voraus wird die nächste Stunde gesucht */
const DUE_SEARCH_DAYS = 28;
/** Widget: Hausaufgaben für die nächsten n Schultage */
export const HOMEWORK_SCHOOL_DAYS = 3;

export interface HomeworkItem {
  entryId: string;
  /** Tag der Stunde, in der sie aufgegeben wurde */
  givenOn: string;
  /** „fällig am“ der Lehrkraft, sonst nächste stattfindende Stunde derselben Gruppe im selben Fach; null = nicht im Plan gefunden */
  due: string | null;
  /** true = Datum von der Lehrkraft gesetzt (Q5-27) */
  dueSet: boolean;
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  color: string;
  homework: string;
}

type Entry = Omit<HomeworkItem, "due" | "dueSet"> & { homeworkDue: string | null };
type Slot = Pick<LessonSlot, "date" | "groupId" | "subjectId" | "change">;

/**
 * Fälligkeit je Eintrag: das gesetzte „fällig am“ (Q5-27), sonst die erste Stunde derselben Gruppe/desselben Fachs nach dem Tag
 * des Eintrags, die nicht entfällt. Rein.
 */
export function withDueDates(entries: readonly Entry[], slots: readonly Slot[]): HomeworkItem[] {
  const sorted = [...slots].sort((a, b) => a.date.localeCompare(b.date));
  return entries.map(({ homeworkDue, ...e }) => ({
    ...e,
    dueSet: homeworkDue !== null,
    due: homeworkDue ?? sorted.find((s) => s.groupId === e.groupId && s.subjectId === e.subjectId && s.date > e.givenOn && s.change?.kind !== "cancel")?.date ?? null,
  }));
}

/**
 * Für das Widget: fällig ab heute bis zum n-ten Schultag (Tage mit Stunden laut Plan), nach Fälligkeit und Fach sortiert. Rein.
 * Ohne Stunden im Plan (Ferien) bleibt die Liste leer.
 */
export function upcoming(items: readonly HomeworkItem[], slots: readonly Pick<LessonSlot, "date">[], today: string, schoolDays = HOMEWORK_SCHOOL_DAYS): HomeworkItem[] {
  const days = [...new Set(slots.map((s) => s.date).filter((d) => d >= today))].sort().slice(0, schoolDays);
  const last = days.at(-1);
  if (!last) return [];
  return items
    .filter((i) => i.due !== null && i.due >= today && i.due <= last)
    .sort((a, b) => a.due!.localeCompare(b.due!) || a.subjectName.localeCompare(b.subjectName, "de") || a.givenOn.localeCompare(b.givenOn));
}

/** Einträge mit Hausaufgabe aus [from, to] – dazu (Q5-27) ältere mit gesetztem „fällig am“ ab `to` (lange Fristen). */
async function entriesOf(db: Db, groupIds: readonly string[], from: string, to: string): Promise<Entry[]> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({
      entryId: classbookEntries.id,
      givenOn: classbookEntries.date,
      groupId: classbookEntries.groupId,
      groupName: groups.name,
      subjectId: classbookEntries.subjectId,
      subjectName: subjects.name,
      color: subjects.color,
      homework: classbookEntries.homework,
      homeworkDue: classbookEntries.homeworkDue,
    })
    .from(classbookEntries)
    .innerJoin(groups, eq(groups.id, classbookEntries.groupId))
    .innerJoin(subjects, eq(subjects.id, classbookEntries.subjectId))
    .where(
      and(
        inArray(classbookEntries.groupId, [...groupIds]),
        isNotNull(classbookEntries.homework),
        lte(classbookEntries.date, to),
        or(gte(classbookEntries.date, from), gte(classbookEntries.homeworkDue, to)),
      ),
    )
    .orderBy(desc(classbookEntries.date), desc(classbookEntries.periodNr));
  // gekoppelte Stunden: dieselbe Hausaufgabe in mehreren Gruppen derselben Person nur einmal
  const seen = new Set<string>();
  return rows
    .map((r) => ({ ...r, homework: r.homework!.trim() }))
    .filter((r) => {
      const key = `${r.givenOn}|${r.subjectId}|${r.homework}|${r.homeworkDue ?? ""}`;
      if (!r.homework || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Hausaufgaben einer Schülerin/eines Schülers, die in den nächsten Schultagen fällig sind (Widget auf Heute). */
export async function upcomingHomeworkFor(db: Db, studentId: string, today: string): Promise<HomeworkItem[]> {
  const gids = (await db.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, studentId))).map((r) => r.g);
  const entries = await entriesOf(db, gids, addDays(today, -HOMEWORK_LOOKBACK_DAYS), today);
  if (entries.length === 0) return [];
  const slots = await listSlots(db, { kind: "user", id: studentId }, addDays(today, -HOMEWORK_LOOKBACK_DAYS), addDays(today, DUE_SEARCH_DAYS));
  return upcoming(withDueDates(entries, slots), slots, today);
}

/** Kursraum: die zuletzt aufgegebenen Hausaufgaben der Gruppe (neueste zuerst) mit Fälligkeit. */
export async function recentHomeworkOfGroup(db: Db, groupId: string, today: string, limit = 5): Promise<HomeworkItem[]> {
  const entries = (await entriesOf(db, [groupId], addDays(today, -HOMEWORK_LOOKBACK_DAYS), today)).slice(0, limit);
  if (entries.length === 0) return [];
  const slots = await listSlots(db, { kind: "group", id: groupId }, entries.at(-1)!.givenOn, addDays(today, DUE_SEARCH_DAYS));
  return withDueDates(entries, slots);
}

/**
 * Wessen Hausaufgaben zeigt das Widget? Schüler:innen sich selbst (immer), Eltern ihre Kinder, deren Jahrgang die
 * Moduleinstellung umfasst (Vorgabe aus → niemand). Andere Rollen: niemand.
 */
export async function homeworkOwners(db: Db, viewer: PermissionSet): Promise<{ id: string; name: string }[]> {
  if (viewer.role === "schueler") {
    const [me] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, viewer.userId));
    return me ? [me] : [];
  }
  if (viewer.role !== "eltern") return [];
  const max = await readGradeSetting(db, PARENTS_HOMEWORK);
  if (max === 0) return [];
  const children = await db
    .select({ id: users.id, name: users.name })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .where(and(eq(parentChild.parentId, viewer.userId), parentInformedSql()))
    .orderBy(de(users.firstName));
  const grades = await sek1GradeOf(
    db,
    children.map((c) => c.id),
  );
  return children.filter((c) => withinGradeSetting(grades.get(c.id), max));
}
