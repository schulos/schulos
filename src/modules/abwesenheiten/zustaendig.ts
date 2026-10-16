// Wer ist für eine Schülerin/einen Schüler zuständig? Klassenleitung, Eltern (nur minderjähriger Kinder), Entscheidungsrecht.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, groups } from "@/core/db/schema";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { isParentFor, parentLinks } from "@/core/school/majority";

/** Klasse(n) und Klassenleitung einer Schülerin/eines Schülers. */
export async function classOf(db: Db, studentId: string) {
  const rows = await db
    .select({ groupId: groups.id, groupName: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, studentId), eq(groups.kind, "klasse")));
  const leaders = rows.length
    ? await db
        .select({ id: groupMembers.userId })
        .from(groupMembers)
        .where(and(inArray(groupMembers.groupId, rows.map((r) => r.groupId)), eq(groupMembers.role, "leader")))
    : [];
  return { groupIds: rows.map((r) => r.groupId), groupName: rows[0]?.groupName ?? null, leaderIds: leaders.map((l) => l.id) };
}

/** Elternteil eines minderjährigen Kindes – nur dann melden und beantragen (I-05, Q5-05). */
export async function isParentOfMinor(db: Db, parentId: string, studentId: string): Promise<boolean> {
  return isParentFor(db, parentId, studentId, "act");
}

/** Elternteil, das Fehlzeiten sehen darf: Kind minderjährig oder eigenständig mit Einwilligung „Eltern weiter informieren“. */
export async function isInformedParentOf(db: Db, parentId: string, studentId: string): Promise<boolean> {
  return isParentFor(db, parentId, studentId, "inform");
}

/** Eltern, die über diese:n Schüler:in informiert werden (bei Eigenständigen nur mit deren Einwilligung). */
export async function informedParents(db: Db, studentId: string): Promise<string[]> {
  return (await parentLinks(db, [studentId], "inform")).map((l) => l.parentId);
}

/** Klassenleitung der Schülerin/des Schülers oder Recht „alle bearbeiten“. */
export async function canDecide(db: Db, viewer: PermissionSet, studentId: string): Promise<boolean> {
  if (hasPermission(viewer, "abwesenheiten.manage")) return true;
  const { groupIds } = await classOf(db, studentId);
  return groupIds.some((g) => viewer.leaderOf.has(g));
}
