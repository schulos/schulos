// SP3-04/SP3-05: Änderungslisten an Schüler:innen und Eltern – Zeilen je Klasse/Kurs (ohne Namen, Lehrkräfte als Kürzel), je Person eine
// gebündelte Nachricht mit den Zeilen ihrer Gruppen (Eltern nach der Moduleinstellung wie bei Vertretungen, alle Kinder in einer Nachricht).
// Gemeinsam für das Veröffentlichen einer Planversion und die Sofort-Korrektur im gültigen Plan.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, groups, subjects, users } from "@/core/db/schema";
import { notifyBundled } from "@/core/notifications";
import type { ChangeNames } from "./plan-uebertrag";
import { informedParents } from "./vertretung-gong";

/**
 * Sendet je Schüler:in (Mitglied der Gruppen) und informierte Eltern eine Nachricht mit den Zeilen aller betroffenen Gruppen. `message`
 * baut Titel und Text aus den Zeilen; ohne Zeilen keine Nachricht. Gibt die Zahl der Nachrichten zurück.
 */
export async function notifyGroupLists(
  db: Db,
  linesByGroup: Readonly<Record<string, readonly string[]>>,
  message: (lines: readonly string[]) => { title: string; body: string },
  opts: { href: string; bundleKey: string },
): Promise<number> {
  const groupIds = Object.keys(linesByGroup);
  if (!groupIds.length) return 0;
  const members = await db
    .select({ u: groupMembers.userId, g: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(inArray(groupMembers.groupId, groupIds), eq(groupMembers.role, "member"), eq(users.role, "schueler")));
  const groupsOf = new Map<string, Set<string>>();
  for (const m of members) groupsOf.set(m.u, (groupsOf.get(m.u) ?? new Set()).add(m.g));
  const linesOf = (gs: Iterable<string>) => [...new Set([...gs].flatMap((g) => linesByGroup[g] ?? []))];
  const items = new Map<string, string[]>();
  for (const [u, gs] of groupsOf) items.set(u, linesOf(gs));
  for (const [p, kids] of await informedParents(db, [...groupsOf.keys()])) {
    if (items.has(p)) continue;
    items.set(p, linesOf([...kids].flatMap((k) => [...(groupsOf.get(k) ?? [])])));
  }
  const list = [...items].filter(([, lines]) => lines.length > 0).map(([userId, lines]) => ({ userId, ...message(lines), href: opts.href }));
  if (!list.length) return 0;
  return notifyBundled(db, list, { moduleId: "stundenplan", bundleKey: opts.bundleKey });
}

/** Namen für Änderungslisten: Gruppen, Fächer, Lehrkräfte als Kürzel (sonst Name). */
export async function changeNames(db: Db): Promise<ChangeNames> {
  const [g, s, t] = await Promise.all([
    db.select({ id: groups.id, name: groups.name }).from(groups),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(eq(users.role, "lehrkraft")),
  ]);
  return {
    groups: new Map(g.map((x) => [x.id, x.name])),
    subjects: new Map(s.map((x) => [x.id, x.name])),
    teachers: new Map(t.map((x) => [x.id, x.code?.trim() || x.name])),
  };
}
