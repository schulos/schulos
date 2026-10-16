// Foren (P3-06): ein Forum je Gruppe (Gruppenmerkmal) plus das Kollegiumsforum; Themen, Antworten (Markdown),
// Abo mit Gong bei neuen Antworten, Volltextsuche. Moderation folgt in P3-07.
import { and, count, desc, eq, inArray, isNull, max, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { forumPosts, forumSubscriptions, forumTopics, groupFeatures, groups, users } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";

export const FORUM_FEATURE = "foren.forum";
export const KOLLEGIUM = "kollegium";
const STAFF = ["lehrkraft", "verwaltung", "admin"];
export const MAX_BODY = 10_000;

/** „kollegium“ oder die id einer Gruppe */
export type ForumKey = string;

const isStaff = (v: PermissionSet) => STAFF.includes(v.role);

/** Gruppen mit Forum, in denen der Betrachter Mitglied ist. */
async function memberForumGroups(db: Db, viewer: PermissionSet, only?: string) {
  if (viewer.memberOf.size === 0) return [];
  const ids = only ? (viewer.memberOf.has(only) ? [only] : []) : [...viewer.memberOf];
  if (ids.length === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, FORUM_FEATURE)))
    .where(and(inArray(groups.id, ids), isNull(groups.archivedAt)))
    .orderBy(de(groups.name));
}

/**
 * Zugang zu einem Forum: lesen (Name) und schreiben. Schreiben nur Mitglieder (Kollegium: Personal); die Moderation
 * (`foren.moderate`) erreicht jedes Forum lesend – z. B. aus einer Meldung heraus –, schreibt aber nicht mit (Review 2026-10-10).
 */
export async function forumAccess(db: Db, viewer: PermissionSet, key: ForumKey): Promise<{ name: string; write: boolean } | null> {
  const moderator = hasPermission(viewer, "foren.moderate");
  if (key === KOLLEGIUM) return isStaff(viewer) ? { name: "Kollegium", write: true } : moderator ? { name: "Kollegium", write: false } : null;
  const [g] = await memberForumGroups(db, viewer, key);
  if (g) return { name: g.name, write: true };
  if (!moderator) return null;
  // Moderation (P3-07) erreicht auch Foren ohne Mitgliedschaft – z. B. aus einer Meldung heraus
  const [any] = await db
    .select({ name: groups.name })
    .from(groups)
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, FORUM_FEATURE)))
    .where(eq(groups.id, key));
  return any ? { name: any.name, write: false } : null;
}

/** Darf der Betrachter dieses Forum lesen? Name des Forums oder null. */
export async function forumName(db: Db, viewer: PermissionSet, key: ForumKey): Promise<string | null> {
  return (await forumAccess(db, viewer, key))?.name ?? null;
}

/** Moderieren: Leitung der Gruppe (Gruppenforum) oder Recht „foren.moderate“ (alle Foren inkl. Kollegium). */
export function canModerate(viewer: PermissionSet, groupId: string | null): boolean {
  return hasPermission(viewer, "foren.moderate") || (groupId !== null && viewer.leaderOf.has(groupId));
}

const scopeOf = (key: ForumKey): SQL => (key === KOLLEGIUM ? isNull(forumTopics.groupId) : eq(forumTopics.groupId, key));

/** Foren des Betrachters mit Zahl der Themen und letzter Aktivität. */
export async function listForums(db: Db, viewer: PermissionSet) {
  const forums: { key: ForumKey; name: string }[] = [
    ...(isStaff(viewer) ? [{ key: KOLLEGIUM, name: "Kollegium" }] : []),
    ...(await memberForumGroups(db, viewer)).map((g) => ({ key: g.id, name: g.name })),
  ];
  if (forums.length === 0) return [];
  const groupIds = forums.filter((f) => f.key !== KOLLEGIUM).map((f) => f.key);
  const stats = await db
    .select({ groupId: forumTopics.groupId, topics: count(), last: max(forumTopics.lastPostAt) })
    .from(forumTopics)
    .where(groupIds.length ? sql`${forumTopics.groupId} is null or ${inArray(forumTopics.groupId, groupIds)}` : isNull(forumTopics.groupId))
    .groupBy(forumTopics.groupId);
  return forums.map((f) => {
    const s = stats.find((x) => (f.key === KOLLEGIUM ? x.groupId === null : x.groupId === f.key));
    return { ...f, topics: s?.topics ?? 0, lastPostAt: s?.last ? new Date(s.last) : null };
  });
}

/** Themen eines Forums, zuletzt aktive zuerst. */
export async function listTopics(db: Db, viewer: PermissionSet, key: ForumKey, limit = 100) {
  if (!(await forumName(db, viewer, key))) throw new ForbiddenError("foren.read");
  const rows = await db
    .select({ id: forumTopics.id, title: forumTopics.title, locked: forumTopics.locked, lastPostAt: forumTopics.lastPostAt, authorName: users.name })
    .from(forumTopics)
    .leftJoin(users, eq(users.id, forumTopics.authorId))
    .where(scopeOf(key))
    .orderBy(desc(forumTopics.lastPostAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const replies = await db
    .select({ topicId: forumPosts.topicId, n: count() })
    .from(forumPosts)
    .where(inArray(forumPosts.topicId, rows.map((r) => r.id)))
    .groupBy(forumPosts.topicId);
  return rows.map((r) => ({ ...r, posts: replies.find((x) => x.topicId === r.id)?.n ?? 0 }));
}

function checkText(title: string | null, body: string) {
  const errors: Record<string, string> = {};
  if (title !== null) {
    if (!title.trim()) errors.title = "Titel fehlt";
    else if (title.trim().length > 140) errors.title = "Höchstens 140 Zeichen";
  }
  if (!body.trim()) errors.body = "Text fehlt";
  else if (body.length > MAX_BODY) errors.body = `Höchstens ${MAX_BODY} Zeichen`;
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

const subscribe = (db: Db, topicId: string, userId: string) => db.insert(forumSubscriptions).values({ topicId, userId }).onConflictDoNothing();

export async function createTopic(db: Db, viewer: PermissionSet, key: ForumKey, input: { title: string; body: string }, now = new Date()): Promise<string> {
  if (!(await forumAccess(db, viewer, key))?.write) throw new ForbiddenError("foren.write");
  checkText(input.title, input.body);
  const id = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(forumTopics)
      .values({ groupId: key === KOLLEGIUM ? null : key, authorId: viewer.userId, title: input.title.trim(), createdAt: now, lastPostAt: now })
      .returning({ id: forumTopics.id });
    await tx.insert(forumPosts).values({ topicId: t!.id, authorId: viewer.userId, body: input.body.trim(), createdAt: now });
    await tx.insert(forumSubscriptions).values({ topicId: t!.id, userId: viewer.userId });
    return t!.id;
  });
  return id;
}

export async function topicWithAccess(db: Db, viewer: PermissionSet, topicId: string) {
  const [t] = await db.select().from(forumTopics).where(eq(forumTopics.id, topicId));
  if (!t) return null;
  const key = t.groupId ?? KOLLEGIUM;
  const access = await forumAccess(db, viewer, key);
  return access ? { topic: t, key, forumName: access.name, canWrite: access.write } : null;
}

/** Ein Thema mit allen Beiträgen (älteste zuerst) und Abo-Stand. */
export async function getTopic(db: Db, viewer: PermissionSet, topicId: string) {
  const access = await topicWithAccess(db, viewer, topicId);
  if (!access) return null;
  const [posts, [sub]] = await Promise.all([
    db
      .select({
        id: forumPosts.id,
        authorId: forumPosts.authorId,
        authorName: users.name,
        body: forumPosts.body,
        createdAt: forumPosts.createdAt,
        editedAt: forumPosts.editedAt,
        hiddenAt: forumPosts.hiddenAt,
        hiddenReason: forumPosts.hiddenReason,
      })
      .from(forumPosts)
      .leftJoin(users, eq(users.id, forumPosts.authorId))
      .where(eq(forumPosts.topicId, topicId))
      .orderBy(forumPosts.createdAt, forumPosts.id),
    db.select().from(forumSubscriptions).where(and(eq(forumSubscriptions.topicId, topicId), eq(forumSubscriptions.userId, viewer.userId))),
  ]);
  const moderate = canModerate(viewer, access.topic.groupId);
  // ausgeblendete Beiträge: Text nur für die Moderation, alle anderen sehen den Grund
  return {
    ...access,
    canModerate: moderate,
    posts: posts.map((p) => ({ ...p, body: p.hiddenAt && !moderate ? null : p.body, mine: p.authorId === viewer.userId })),
    subscribed: !!sub,
  };
}

/** Antwort: Thema darf nicht gesperrt sein; Autor:in abonniert; Gong an alle anderen Abonnent:innen. */
export async function reply(db: Db, viewer: PermissionSet, topicId: string, body: string, now = new Date()): Promise<string> {
  const access = await topicWithAccess(db, viewer, topicId);
  if (!access?.canWrite) throw new ForbiddenError("foren.write");
  if (access.topic.locked) throw new ValidationError({ body: "Das Thema ist gesperrt" });
  checkText(null, body);
  const [post] = await db.insert(forumPosts).values({ topicId, authorId: viewer.userId, body: body.trim(), createdAt: now }).returning({ id: forumPosts.id });
  await db.update(forumTopics).set({ lastPostAt: now }).where(eq(forumTopics.id, topicId));
  await subscribe(db, topicId, viewer.userId);
  const subs = await db.select({ id: forumSubscriptions.userId }).from(forumSubscriptions).where(eq(forumSubscriptions.topicId, topicId));
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId));
  const to = subs.map((s) => s.id).filter((id) => id !== viewer.userId);
  if (to.length) await notify(db, to, { moduleId: "foren", title: `Neue Antwort: ${access.topic.title}`, body: `${me?.name ?? "Jemand"} in ${access.forumName}`, href: `/foren/thema/${topicId}#${post!.id}` });
  return post!.id;
}

/** Eigenen Beitrag bearbeiten. */
export async function editPost(db: Db, viewer: PermissionSet, postId: string, body: string, now = new Date()): Promise<void> {
  const [p] = await db.select().from(forumPosts).where(eq(forumPosts.id, postId));
  const access = p && (await topicWithAccess(db, viewer, p.topicId));
  if (!p || !access?.canWrite || p.authorId !== viewer.userId || p.hiddenAt) throw new ForbiddenError("foren.write");
  // gesperrte Themen bleiben eingefroren – auch eigene Beiträge (die Oberfläche blendet „Bearbeiten“ dort schon aus)
  if (access.topic.locked) throw new ValidationError({ body: "Das Thema ist gesperrt" });
  checkText(null, body);
  await db.update(forumPosts).set({ body: body.trim(), editedAt: now }).where(eq(forumPosts.id, postId));
}

export async function setSubscription(db: Db, viewer: PermissionSet, topicId: string, on: boolean): Promise<void> {
  if (!(await topicWithAccess(db, viewer, topicId))?.canWrite) throw new ForbiddenError("foren.read");
  if (on) await subscribe(db, topicId, viewer.userId);
  else await db.delete(forumSubscriptions).where(and(eq(forumSubscriptions.topicId, topicId), eq(forumSubscriptions.userId, viewer.userId)));
}

/** Volltextsuche über Titel und Beiträge der eigenen Foren (deutsche Stammformen wie bei News). */
export async function searchTopics(db: Db, viewer: PermissionSet, q: string, limit = 5) {
  const forums = await listForums(db, viewer);
  if (forums.length === 0 || !q.trim()) return [];
  const groupIds = forums.filter((f) => f.key !== KOLLEGIUM).map((f) => f.key);
  const scope: SQL[] = [];
  if (forums.some((f) => f.key === KOLLEGIUM)) scope.push(isNull(forumTopics.groupId));
  if (groupIds.length) scope.push(inArray(forumTopics.groupId, groupIds));
  const match = sql`to_tsvector('german', ${forumTopics.title} || ' ' || ${forumPosts.body}) @@ websearch_to_tsquery('german', ${q})`;
  const rows = await db
    .selectDistinct({ id: forumTopics.id, title: forumTopics.title, groupId: forumTopics.groupId, lastPostAt: forumTopics.lastPostAt })
    .from(forumTopics)
    .innerJoin(forumPosts, eq(forumPosts.topicId, forumTopics.id))
    .where(and(sql`(${sql.join(scope, sql` or `)})`, isNull(forumPosts.hiddenAt), match))
    .orderBy(desc(forumTopics.lastPostAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, forumName: forums.find((f) => (r.groupId ? f.key === r.groupId : f.key === KOLLEGIUM))?.name ?? "" }));
}
