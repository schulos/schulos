// Adressbuch: wer darf wen sehen – die EINE Stelle für Sichtbarkeit von Personen und Gruppen.
// Wird auch von der globalen Suche benutzt.
import { and, asc, eq, ilike, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { chatMembers, groupMembers, groups, profilePhotos, subjects, users } from "@/core/db/schema";
import { childIdsQuery } from "@/core/school/majority";
import type { PermissionSet } from "@/core/permissions";
import { de } from "@/core/db/sort";

const STAFF = ["lehrkraft", "verwaltung", "admin"] as const;
const isStaff = (p: PermissionSet) => (STAFF as readonly string[]).includes(p.role);
/** Erwachsene der Schule – das Verzeichnis für Personal und Beratung */
const ADULTS = ["lehrkraft", "verwaltung", "personal", "beratung"] as const;

/**
 * Bedingung „diese Person darf der Betrachter sehen":
 *  - Lehrkräfte, Verwaltung und Admin sehen alle
 *  - Lehrkräfte und Verwaltung sind für alle sichtbar
 *  - Rolle „Personal“ (Hausmeisterei u. a., P4-10) sieht nur Erwachsene der Schule: Lehrkräfte, Verwaltung, Personal –
 *    kein Schüler- oder Elternverzeichnis; für Schüler:innen und Eltern ist das Personal nicht sichtbar
 *  - Rolle „Beratung“ (Schulsozialarbeit, Q5-17) ist für alle sichtbar (mit Sprechzeiten); sie selbst sieht Erwachsene der
 *    Schule, Mitglieder ihrer Gruppen und Personen, mit denen schon ein Direktchat besteht – kein Klassen-/Elternverzeichnis
 *  - Schüler:innen sehen zusätzlich Mitglieder ihrer Gruppen
 *  - Eltern sehen zusätzlich ihre Kinder
 * Gesperrte Konten erscheinen nur für Lehrkräfte, Verwaltung und Admin.
 */
export async function visiblePeople(db: Db, viewer: PermissionSet): Promise<SQL | undefined> {
  if (isStaff(viewer)) return undefined;
  if (viewer.role === "personal") return and(or(inArray(users.role, ADULTS), eq(users.id, viewer.userId)), eq(users.status, "active"));
  if (viewer.role === "beratung") {
    const parts: SQL[] = [inArray(users.role, ADULTS), eq(users.id, viewer.userId)];
    if (viewer.memberOf.size > 0) {
      parts.push(inArray(users.id, db.select({ id: groupMembers.userId }).from(groupMembers).where(inArray(groupMembers.groupId, [...viewer.memberOf]))));
    }
    // Gegenüber in bestehenden Direktchats (die Schüler:innen/Eltern begonnen haben)
    const myRooms = db.select({ id: chatMembers.roomId }).from(chatMembers).where(eq(chatMembers.userId, viewer.userId));
    parts.push(inArray(users.id, db.select({ id: chatMembers.userId }).from(chatMembers).where(inArray(chatMembers.roomId, myRooms))));
    return and(or(...parts), eq(users.status, "active"));
  }
  const parts: SQL[] = [inArray(users.role, ["lehrkraft", "verwaltung", "beratung"]), eq(users.id, viewer.userId)];
  if (viewer.role === "schueler" && viewer.memberOf.size > 0) {
    parts.push(inArray(users.id, db.select({ id: groupMembers.userId }).from(groupMembers).where(inArray(groupMembers.groupId, [...viewer.memberOf]))));
  }
  if (viewer.role === "eltern") {
    // Q5-05: eigenständige Kinder nur mit deren Einwilligung
    parts.push(inArray(users.id, childIdsQuery(db, viewer.userId, "inform")));
  }
  return and(or(...parts), eq(users.status, "active"));
}

/** Sichtbare Gruppen: Personal alle, sonst nur eigene. */
export function visibleGroups(viewer: PermissionSet): SQL | undefined {
  if (isStaff(viewer)) return undefined;
  if (viewer.memberOf.size === 0) return eq(groups.id, "__none__");
  return inArray(groups.id, [...viewer.memberOf]);
}

/** Jedes Suchwort muss in Name, Benutzername oder Kürzel vorkommen („jana bra"). */
function tokenMatch(q: string, cols: Parameters<typeof ilike>[0][]): SQL | undefined {
  const tokens = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (tokens.length === 0) return undefined;
  return and(
    ...tokens.map((t) => {
      const like = `%${t.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      return or(...cols.map((c) => ilike(c, like)))!;
    }),
  );
}

export interface PersonHit {
  id: string;
  name: string;
  role: (typeof users.$inferSelect)["role"];
  shortCode: string | null;
}

export async function searchPeople(db: Db, viewer: PermissionSet, q: string, limit = 8): Promise<PersonHit[]> {
  const match = tokenMatch(q, [users.name, users.username, users.shortCode]);
  if (!match) return [];
  return db
    .select({ id: users.id, name: users.name, role: users.role, shortCode: users.shortCode })
    .from(users)
    .where(and(match, await visiblePeople(db, viewer)))
    .orderBy(de(users.lastName), de(users.firstName))
    .limit(limit);
}

export async function searchGroups(db: Db, viewer: PermissionSet, q: string, limit = 6) {
  const match = tokenMatch(q, [groups.name, groups.slug]);
  if (!match) return [];
  return db
    .select({ id: groups.id, name: groups.name, kind: groups.kind })
    .from(groups)
    .where(and(match, visibleGroups(viewer), isNull(groups.archivedAt)))
    .orderBy(de(groups.name))
    .limit(limit);
}

/** Alle Lehrkräfte mit Fächern (aus den Fachschaften) – fürs Adressbuch. */
export async function listTeachers(db: Db) {
  const [teachers, fs] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName, shortCode: users.shortCode, photoAt: profilePhotos.createdAt })
      .from(users)
      .leftJoin(profilePhotos, eq(profilePhotos.userId, users.id))
      .where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")))
      .orderBy(de(users.lastName), de(users.firstName)),
    db
      .select({ userId: groupMembers.userId, subject: subjects.name, color: subjects.color })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(subjects, eq(subjects.id, groups.subjectId))
      .where(eq(groups.kind, "fachschaft"))
      .orderBy(asc(subjects.sortOrder)),
  ]);
  return teachers.map((t) => ({ ...t, subjects: fs.filter((f) => f.userId === t.id).map(({ subject, color }) => ({ name: subject, color })) }));
}

/** Schulsozialarbeit/Beratung (Q5-17) mit Sprechzeiten – für alle sichtbar, im Adressbuch als eigene Karte. */
export async function listCounselors(db: Db) {
  return db
    .select({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName, officeHours: users.officeHours, photoAt: profilePhotos.createdAt })
    .from(users)
    .leftJoin(profilePhotos, eq(profilePhotos.userId, users.id))
    .where(and(eq(users.role, "beratung"), eq(users.status, "active")))
    .orderBy(de(users.lastName), de(users.firstName));
}

/** Profil einer Person – null, wenn nicht sichtbar. Gemeinsame Gruppen statt aller Gruppen (Datensparsamkeit). */
export async function getPersonProfile(db: Db, viewer: PermissionSet, id: string) {
  const [person] = await db
    .select({
      id: users.id,
      name: users.name,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      shortCode: users.shortCode,
      username: users.username,
      officeHours: users.officeHours,
      photoAt: profilePhotos.createdAt,
    })
    .from(users)
    .leftJoin(profilePhotos, eq(profilePhotos.userId, users.id))
    .where(and(eq(users.id, id), await visiblePeople(db, viewer)));
  if (!person) return null;

  const rows = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, subjectId: groups.subjectId, memberRole: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, id))
    .orderBy(asc(groups.kind), de(groups.name));
  const shown = isStaff(viewer) || person.id === viewer.userId ? rows : rows.filter((g) => viewer.memberOf.has(g.id));
  const subjectIds = rows.filter((r) => r.kind === "fachschaft" && r.subjectId).map((r) => r.subjectId!);
  const subj = subjectIds.length ? await db.select().from(subjects).where(inArray(subjects.id, subjectIds)).orderBy(asc(subjects.sortOrder)) : [];
  return {
    person,
    subjects: subj.map((s) => ({ name: s.name, color: s.color })),
    classLeads: rows.filter((r) => r.kind === "klasse" && r.memberRole === "leader").map((r) => r.name),
    groups: shown,
    groupsAreShared: !(isStaff(viewer) || person.id === viewer.userId),
  };
}

/** Gruppenprofil mit Mitgliedern – nur für Mitglieder und Personal. */
export async function getGroupProfile(db: Db, viewer: PermissionSet, id: string) {
  const [group] = await db.select().from(groups).where(and(eq(groups.id, id), visibleGroups(viewer)));
  if (!group) return null;
  const members = await db
    .select({ id: users.id, name: users.name, role: users.role, shortCode: users.shortCode, memberRole: groupMembers.role, photoAt: profilePhotos.createdAt })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(profilePhotos, eq(profilePhotos.userId, users.id))
    .where(and(eq(groupMembers.groupId, id), ne(users.status, "locked")))
    .orderBy(de(users.lastName), de(users.firstName));
  return { group, members };
}
