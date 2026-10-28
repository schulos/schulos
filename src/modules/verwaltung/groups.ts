// Gruppenverwaltung – Service-Funktionen.
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { audit } from "@/core/audit";
import { notify } from "@/core/notifications";
import type { Db } from "@/core/db/client";
import { gradeLevels, GROUP_KINDS, groupFeatures, type GroupKind, groupMembers, groups, notenbuchBooks, rooms, schoolYears, subjects, users } from "@/core/db/schema";
import type { ModuleManifest } from "@/core/modules/types";
import { LEVEL_LABELS } from "@/core/school/catalog";
import { assertMayAddToGroup, loadActor } from "./escalation";
import { ValidationError } from "./users";
import { de } from "@/core/db/sort";

export interface GroupListRow {
  id: string;
  name: string;
  slug: string;
  kind: GroupKind;
  gradeLevel: number | null;
  level: string | null;
  members: number;
  leaders: string[];
}

/** Gruppenliste; archivierte Gruppen (alte Schuljahre) nur mit `archived: true`. */
export async function listGroups(db: Db, f: { q?: string; kind?: GroupKind; archived?: boolean } = {}): Promise<GroupListRow[]> {
  const where: SQL[] = [f.archived ? isNotNull(groups.archivedAt) : isNull(groups.archivedAt)];
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(groups.name, like), ilike(groups.slug, like))!);
  }
  if (f.kind) where.push(eq(groups.kind, f.kind));
  const rows = await db
    .select({ id: groups.id, name: groups.name, slug: groups.slug, kind: groups.kind, gradeLevel: groups.gradeLevel, level: groups.level, members: count(groupMembers.userId) })
    .from(groups)
    .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .where(where.length ? and(...where) : undefined)
    .groupBy(groups.id)
    .orderBy(asc(groups.kind), asc(groups.gradeLevel), de(groups.name));
  const ids = rows.map((r) => r.id);
  const leaders = ids.length
    ? await db
        .select({ groupId: groupMembers.groupId, name: users.name, shortCode: users.shortCode })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(and(inArray(groupMembers.groupId, ids), eq(groupMembers.role, "leader")))
    : [];
  return rows.map((r) => ({
    ...r,
    leaders: leaders.filter((l) => l.groupId === r.id).map((l) => l.shortCode ?? l.name),
  }));
}

export async function getGroup(db: Db, id: string) {
  const [group] = await db.select().from(groups).where(eq(groups.id, id));
  if (!group) return null;
  const [members, features] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, firstName: users.firstName, lastName: users.lastName, role: users.role, shortCode: users.shortCode, memberRole: groupMembers.role })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, id))
      // Leitung zuerst. Achtung: Postgres sortiert Enums nach Deklaration (member < leader), nicht alphabetisch.
      .orderBy(desc(groupMembers.role), de(users.lastName), de(users.firstName)),
    db.select({ feature: groupFeatures.feature }).from(groupFeatures).where(eq(groupFeatures.groupId, id)),
  ]);
  return { group, members, features: features.map((f) => f.feature) };
}

/** „Klasse 7b" → „klasse-7b"; Umlaute werden ersetzt. */
export function slugify(input: string): string {
  const map: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };
  return input
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => map[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function freeSlug(db: Db, base: string, exceptId?: string): Promise<string> {
  const root = base || "gruppe";
  const taken = new Set(
    (await db.select({ id: groups.id, slug: groups.slug }).from(groups).where(ilike(groups.slug, `${root}%`)))
      .filter((g) => g.id !== exceptId)
      .map((g) => g.slug),
  );
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
}

export interface GroupInput {
  name: string;
  kind: GroupKind;
  description?: string | null;
  gradeLevel?: number | null;
  /** Kursniveau, z. B. „E“, „G“, „GK“, „LK“ */
  level?: string | null;
  subjectId?: string | null;
  /** Stammraum (Klassenraum) */
  homeRoomId?: string | null;
}

async function validate(db: Db, input: GroupInput) {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (!name) errors.name = "Name fehlt";
  if (!GROUP_KINDS.includes(input.kind)) errors.kind = "Unbekannte Gruppenart";
  if (input.gradeLevel != null) {
    const levels = await db.select({ level: gradeLevels.level }).from(gradeLevels);
    const ok = levels.length ? levels.some((l) => l.level === input.gradeLevel) : input.gradeLevel >= 1 && input.gradeLevel <= 13;
    if (!ok) errors.gradeLevel = "Unbekannter Jahrgang";
  }
  if (input.level && !(input.level in LEVEL_LABELS)) errors.level = "Unbekanntes Niveau";
  if (input.subjectId) {
    const [s] = await db.select().from(subjects).where(eq(subjects.id, input.subjectId));
    if (!s) errors.subjectId = "Unbekanntes Fach";
  }
  if (input.homeRoomId) {
    const [r] = await db.select({ active: rooms.active }).from(rooms).where(eq(rooms.id, input.homeRoomId));
    if (!r?.active) errors.homeRoomId = "Raum gibt es nicht oder ist inaktiv";
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return name;
}

export async function createGroup(db: Db, actorId: string, input: GroupInput): Promise<string> {
  const name = await validate(db, input);
  const [year] = await db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  const slug = await freeSlug(db, slugify(name));
  const [g] = await db
    .insert(groups)
    .values({
      name,
      slug,
      kind: input.kind,
      description: input.description?.trim() || null,
      gradeLevel: input.gradeLevel ?? null,
      level: input.level || null,
      subjectId: input.subjectId || null,
      homeRoomId: input.homeRoomId || null,
      schoolYearId: ["klasse", "kurs", "ag", "wahlpflicht", "foerderkurs"].includes(input.kind) ? (year?.id ?? null) : null,
      ownerId: actorId,
    })
    .returning({ id: groups.id });
  await audit(db, actorId, "verwaltung.group.create", g!.id, { name, kind: input.kind });
  return g!.id;
}

export async function updateGroup(db: Db, actorId: string, id: string, input: GroupInput): Promise<void> {
  const name = await validate(db, input);
  await db
    .update(groups)
    .set({ name, kind: input.kind, description: input.description?.trim() || null, gradeLevel: input.gradeLevel ?? null, level: input.level || null, subjectId: input.subjectId || null, homeRoomId: input.homeRoomId || null })
    .where(eq(groups.id, id));
  await audit(db, actorId, "verwaltung.group.update", id, { name });
}

/**
 * Gruppe löschen. GATE-5a (G5A-C06): nicht, solange Notenbücher an ihr hängen – die gehören der Schule und gehen nur mit ihrer
 * Löschfrist (LK-SJ-1J, Löschlauf); die Gruppe wird stattdessen archiviert (Schuljahreswechsel).
 */
export async function deleteGroup(db: Db, actorId: string, id: string): Promise<void> {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(notenbuchBooks).where(eq(notenbuchBooks.groupId, id));
  if (n > 0)
    throw new ValidationError({
      group: `Die Gruppe hat ${n} ${n === 1 ? "Notenbuch" : "Notenbücher"} – die gehören der Schule und bleiben bis zum Ende ihrer Löschfrist. Gruppe archivieren statt löschen.`,
    });
  const [g] = await db.delete(groups).where(eq(groups.id, id)).returning({ name: groups.name });
  if (g) await audit(db, actorId, "verwaltung.group.delete", id, { name: g.name });
}

export async function addMembers(db: Db, actorId: string, groupId: string, userIds: string[], role: "member" | "leader" = "member"): Promise<number> {
  if (userIds.length === 0) return 0;
  // SEC-04: Gruppen mit eigenen Rechten – nicht sich selbst aufnehmen, keine Rechte weitergeben, die man nicht hat
  await assertMayAddToGroup(db, await loadActor(db, actorId), groupId, userIds);
  const inserted = await db
    .insert(groupMembers)
    .values(userIds.map((userId) => ({ groupId, userId, role })))
    .onConflictDoNothing()
    .returning({ userId: groupMembers.userId });
  if (inserted.length) {
    await audit(db, actorId, "verwaltung.group.members_add", groupId, { userIds: inserted.map((i) => i.userId) });
    const [g] = await db.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId));
    await notify(db, inserted.map((i) => i.userId).filter((id) => id !== actorId), {
      moduleId: "verwaltung",
      title: role === "leader" ? `Du leitest jetzt „${g?.name}“` : `Du bist jetzt in „${g?.name}“`,
      body: "Neue Gruppe in SchulOS",
    });
  }
  return inserted.length;
}

export async function removeMember(db: Db, actorId: string, groupId: string, userId: string): Promise<void> {
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  await audit(db, actorId, "verwaltung.group.member_remove", groupId, { userId });
}

export async function setMemberRole(db: Db, actorId: string, groupId: string, userId: string, role: "member" | "leader"): Promise<void> {
  await db.update(groupMembers).set({ role }).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  await audit(db, actorId, "verwaltung.group.member_role", groupId, { userId, role });
}

/** Personen-Suche für „Mitglied hinzufügen" (ohne die, die schon drin sind). */
export async function searchCandidates(db: Db, groupId: string, q: string, limit = 12) {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const existing = db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, groupId));
  return db
    .select({ id: users.id, name: users.name, role: users.role, shortCode: users.shortCode, username: users.username })
    .from(users)
    .where(and(or(ilike(users.name, like), ilike(users.username, like), ilike(users.shortCode, like)), notInArray(users.id, existing), eq(users.status, "active")))
    .orderBy(de(users.lastName), de(users.firstName))
    .limit(limit);
}

/**
 * Alle Gruppenmerkmale, die die Module anbieten – mit `kind` nur die für diese Gruppenart (GT-01: `groupFeatureRules.kinds`), mit
 * `course` ohne die, die nur die Gruppenverwaltung schaltet (`manageOnly`).
 */
export function availableGroupFeatures(manifests: readonly ModuleManifest[], opts: { kind?: GroupKind; course?: boolean } = {}) {
  return manifests.flatMap((m) =>
    Object.entries(m.groupFeatures ?? {})
      .filter(([id]) => {
        const rule = m.groupFeatureRules?.[id];
        if (!rule) return true;
        if (opts.kind && rule.kinds && !rule.kinds.includes(opts.kind)) return false;
        return !(opts.course && rule.manageOnly);
      })
      .map(([id, label]) => ({ id, label, moduleId: m.id, moduleName: m.name })),
  );
}

export async function setGroupFeature(db: Db, actorId: string, groupId: string, feature: string, enabled: boolean): Promise<void> {
  if (enabled) await db.insert(groupFeatures).values({ groupId, feature }).onConflictDoNothing();
  else await db.delete(groupFeatures).where(and(eq(groupFeatures.groupId, groupId), eq(groupFeatures.feature, feature)));
  await audit(db, actorId, "verwaltung.group.feature", groupId, { feature, enabled });
}
