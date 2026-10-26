// Schulbücherei – Klassenleitung sieht offene Schulbücher ihrer Klasse (BU-16, Q-BU-9-3, docs/BUECHEREI.md „Klassenleitung“).
// Je Schüler:in nur der Name und zwei Zahlen: offene Schulbücher (nur mit eingeschalteter Schulbuchausleihe) und offene
// Ersatzforderungen – **keine Titel, keine Inventarnummern, keine Gründe oder Beträge**. Ausleihen der Bücherei (Stufe 1) zählen
// hier bewusst nicht: was jemand liest, ist privat. Kein eigenes Recht: Die Prüfung läuft über die Klassenleitung (Lehrkraft als
// „leader“ einer aktiven Klasse) wie im Notenbuch (`ledClasses`). Die Zahlen kommen aus `openItemsOf` (BU-13), das ohnehin nur zählt.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { groupMembers, groups, users } from "@/core/db/schema";
import { accessBlocked, ForbiddenError, type PermissionSet } from "@/core/permissions";
import { lernmittelEnabled } from "./lernmittel";
import { openItemsOf } from "./offen";

/** Aktive Klassen, die die Person als Lehrkraft leitet (Muster wie `ledClasses` im Notenbuch). */
export async function classLeadClasses(db: Db, perms: PermissionSet): Promise<{ id: string; name: string }[]> {
  if (accessBlocked(perms) || perms.role !== "lehrkraft" || perms.leaderOf.size === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(inArray(groups.id, [...perms.leaderOf]), eq(groups.kind, "klasse"), isNull(groups.archivedAt)))
    .orderBy(de(groups.name), groups.id);
}

/** Leitet die Person mindestens eine aktive Klasse? (Reiter „Meine Klasse“) */
export async function isClassLead(db: Db, perms: PermissionSet): Promise<boolean> {
  return (await classLeadClasses(db, perms)).length > 0;
}

/** Eine Zeile der Klassenansicht – bewusst nur Name und Zahlen. */
export interface ClassOpenRow {
  userId: string;
  name: string;
  /** offene (ausgegebene, nicht zurückgenommene) Schulbücher; 0, wenn die Schulbuchausleihe aus ist */
  schoolbooks: number;
  /** offene Ersatzforderungen (Bücherei und Schulbücher) */
  compensations: number;
}

export interface ClassOpenItems {
  /** Schulbuchausleihe eingeschaltet? Sonst gibt es nur Ersatzforderungen */
  stage2: boolean;
  classes: { id: string; name: string; students: ClassOpenRow[] }[];
}

/**
 * Offene Schulbücher und Ersatzforderungen je Schüler:in der eigenen Klasse(n) – nur Zahlen, ohne Titel. Nur für die
 * Klassenleitung; wer keine aktive Klasse leitet (auch Verwaltung, Büchereiteam, Schulleitung), bekommt `ForbiddenError`.
 */
export async function classOpenItems(db: Db, viewer: PermissionSet): Promise<ClassOpenItems> {
  const classes = await classLeadClasses(db, viewer);
  if (classes.length === 0) throw new ForbiddenError("buecherei.klassenleitung");
  const members = await db
    .select({ groupId: groupMembers.groupId, id: users.id, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(
        inArray(
          groupMembers.groupId,
          classes.map((c) => c.id),
        ),
        eq(groupMembers.role, "member"),
        eq(users.role, "schueler"),
        eq(users.status, "active"),
      ),
    )
    .orderBy(de(users.lastName), de(users.firstName), users.id);
  const [stage2, open] = await Promise.all([lernmittelEnabled(db), openItemsOf(db, [...new Set(members.map((m) => m.id))])]);
  return {
    stage2,
    classes: classes.map((c) => ({
      ...c,
      // nur die beiden Zahlen übernehmen – die Ausleihen der Bücherei (Stufe 1) bleiben draußen
      students: members
        .filter((m) => m.groupId === c.id)
        .map((m) => {
          const o = open.get(m.id);
          return { userId: m.id, name: m.name, schoolbooks: stage2 ? (o?.schoolbooks ?? 0) : 0, compensations: o?.compensations ?? 0 };
        }),
    })),
  };
}
