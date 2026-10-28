// Zielgruppen „Rollen oder Gruppen, keine = alle“ (News, Handbuch HB-01): wer einen Eintrag sieht. Gemeinsamer Baustein,
// damit die Regel (Eltern sehen mit, was an die Gruppen ihrer Kinder geht – eigenständige Kinder nur mit Einwilligung) an
// einer Stelle steht.
import { and, asc, eq, exists, inArray, notExists, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { groupMembers, groups } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import type { PermissionSet } from "@/core/permissions";
import { childIdsQuery } from "./majority";

/** Gruppen, deren Einträge der Betrachter sieht: eigene + (für Eltern) die der Kinder. */
export async function audienceGroups(db: Db, viewer: PermissionSet): Promise<string[]> {
  const ids = new Set(viewer.memberOf);
  if (viewer.role === "eltern") {
    const rows = await db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      // Q5-05: eigenständige Kinder nur mit deren Einwilligung
      .where(inArray(groupMembers.userId, childIdsQuery(db, viewer.userId, "inform")));
    rows.forEach((r) => ids.add(r.groupId));
  }
  return [...ids];
}

/** Zielgruppen-Tabelle eines Moduls: Zeile = (Eintrag, Rolle) oder (Eintrag, Gruppe). */
export interface TargetTable {
  table: PgTable;
  /** Spalte mit dem Verweis auf den Eintrag (z. B. `news_targets.post_id`) */
  owner: AnyPgColumn;
  role: AnyPgColumn;
  groupId: AnyPgColumn;
}

/**
 * Bedingung „der Eintrag `ownerId` richtet sich an den Betrachter“: ohne Zielgruppen-Zeile an alle, sonst passende Rolle oder
 * eine Gruppe aus `audience` (siehe `audienceGroups`).
 */
export function targetedTo(db: Db, t: TargetTable, ownerId: AnyPgColumn, viewer: PermissionSet, audience: readonly string[]): SQL {
  const match = [eq(t.role, viewer.role)];
  if (audience.length) match.push(inArray(t.groupId, [...audience]));
  return or(
    notExists(db.select({ x: sql`1` }).from(t.table).where(eq(t.owner, ownerId))),
    exists(db.select({ x: sql`1` }).from(t.table).where(and(eq(t.owner, ownerId), or(...match)))),
  )!;
}

/** Gruppen, die man als Zielgruppe wählen kann: Personal (Lehrkraft, Verwaltung, Admin) alle, sonst eigene. */
export async function targetableGroups(db: Db, actor: PermissionSet) {
  const staff = ["lehrkraft", "verwaltung", "admin"].includes(actor.role);
  return db
    .select({ id: groups.id, name: groups.name, kind: groups.kind })
    .from(groups)
    .where(staff ? undefined : inArray(groups.id, [...actor.memberOf, "__none__"]))
    .orderBy(asc(groups.kind), asc(groups.gradeLevel), de(groups.name));
}
