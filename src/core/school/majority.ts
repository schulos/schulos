// Volljährigkeit (I-05, Q5-05): Wer „eigenständig (volljährig)“ ist (`users.self_responsible`, setzt die Verwaltung), handelt
// selbst – meldet Abwesenheiten, beantragt Beurlaubungen, bekommt Elternbriefe und Eltern-Umfragen. Eltern handeln dann nicht
// mehr für die Person und sehen ihre Daten nicht mehr (Fehlzeiten, Stundenplan, Kalender, Klausuren, Adressbuch …).
// Ausnahme: Die Person willigt selbst ein, dass ihre Eltern weiter **informiert** werden (`parents_informed_since`) – dann
// sehen die Eltern wieder, was sie über ein minderjähriges Kind sähen, handeln aber weiterhin nicht (melden, beantragen,
// bestätigen, abstimmen tut nur die Person). Alle Stellen fragen hier nach.
import { and, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { parentChild, users } from "@/core/db/schema";

/** SQL auf `users` (das Kind): Eltern handeln für das Kind – nur, solange es nicht eigenständig ist. */
export function parentActsSql(): SQL {
  return eq(users.selfResponsible, false);
}

/** SQL auf `users` (das Kind): Eltern sehen Daten des Kindes / werden informiert – minderjährig oder mit Einwilligung. */
export function parentInformedSql(): SQL {
  return or(eq(users.selfResponsible, false), isNotNull(users.parentsInformedSince))!;
}

export type ParentMode = "act" | "inform";
const modeSql = (mode: ParentMode) => (mode === "act" ? parentActsSql() : parentInformedSql());

/** Schüler:innen aus der Liste, die eigenständig (volljährig) handeln. */
export async function selfResponsibleIds(db: Db, studentIds: readonly string[]): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...studentIds]), eq(users.selfResponsible, true)));
  return new Set(rows.map((r) => r.id));
}

export async function isSelfResponsible(db: Db, studentId: string): Promise<boolean> {
  return (await selfResponsibleIds(db, [studentId])).has(studentId);
}

/** Kinder eines Elternteils, für die es handelt (`act`) bzw. über die es informiert wird (`inform`). */
export async function childrenOf(db: Db, parentId: string, mode: ParentMode): Promise<{ id: string; name: string; firstName: string }[]> {
  return db
    .select({ id: users.id, name: users.name, firstName: users.firstName })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .where(and(eq(parentChild.parentId, parentId), modeSql(mode)));
}

/** Unterabfrage „Kind-IDs dieses Elternteils“ für `inArray(…)` – gefiltert nach `mode`. */
export function childIdsQuery(db: Db, parentId: string, mode: ParentMode) {
  return db
    .select({ id: parentChild.childId })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .where(and(eq(parentChild.parentId, parentId), modeSql(mode)));
}

/** Elternpaare (Eltern-ID, Kind-ID) zu diesen Kindern – nur, wo die Eltern handeln bzw. informiert werden. */
export async function parentLinks(db: Db, studentIds: readonly string[], mode: ParentMode): Promise<{ parentId: string; childId: string }[]> {
  if (studentIds.length === 0) return [];
  return db
    .select({ parentId: parentChild.parentId, childId: parentChild.childId })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .where(and(inArray(parentChild.childId, [...studentIds]), modeSql(mode)));
}

/** Ist `parentId` Elternteil von `studentId` – und handelt bzw. wird informiert? */
export async function isParentFor(db: Db, parentId: string, studentId: string, mode: ParentMode): Promise<boolean> {
  const [r] = await db
    .select({ id: parentChild.childId })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .where(and(eq(parentChild.parentId, parentId), eq(parentChild.childId, studentId), modeSql(mode)));
  return !!r;
}

/**
 * Wer an Stelle „der Eltern“ angesprochen wird (Elternbrief, Eltern-Umfrage, Gong „nicht entschuldigt“): bei Minderjährigen
 * die Eltern, bei Eigenständigen die Person selbst – plus ihre Eltern, wenn sie eingewilligt hat und `withInformed` gesetzt ist.
 */
export async function guardianRecipients(db: Db, studentIds: readonly string[], opts: { withInformed: boolean }): Promise<string[]> {
  if (studentIds.length === 0) return [];
  const self = await selfResponsibleIds(db, studentIds);
  const links = await parentLinks(db, studentIds, opts.withInformed ? "inform" : "act");
  return [...new Set([...self, ...links.map((l) => l.parentId)])];
}
