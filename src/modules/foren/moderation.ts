// Foren-Moderation (P3-07): Beiträge ausblenden (mit Grund, protokolliert), Themen sperren, Meldungen für alle.
// Moderieren dürfen die Leitung einer Gruppe in ihrem Forum und Konten mit „foren.moderate“ in allen Foren.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { forumPosts, forumReports, forumTopics, groupMembers, groups, users } from "@/core/db/schema";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { canModerate, KOLLEGIUM, topicWithAccess } from "./service";

function checkReason(reason: string, field = "reason") {
  const r = reason.trim();
  if (r.length < 3) throw new ValidationError({ [field]: "Bitte einen Grund angeben" });
  if (r.length > 300) throw new ValidationError({ [field]: "Höchstens 300 Zeichen" });
  return r;
}

async function postWithTopic(db: Db, postId: string) {
  const [row] = await db
    .select({ post: forumPosts, groupId: forumTopics.groupId, topicTitle: forumTopics.title })
    .from(forumPosts)
    .innerJoin(forumTopics, eq(forumTopics.id, forumPosts.topicId))
    .where(eq(forumPosts.id, postId));
  return row ?? null;
}

async function requireModeration(db: Db, viewer: PermissionSet, postId: string) {
  const row = await postWithTopic(db, postId);
  if (!row || !canModerate(viewer, row.groupId) || !(await topicWithAccess(db, viewer, row.post.topicId))) throw new ForbiddenError("foren.moderate");
  return row;
}

/** Beitrag ausblenden: bleibt gespeichert (Nachweis), Text nur noch für die Moderation sichtbar. */
export async function hidePost(db: Db, viewer: PermissionSet, postId: string, reason: string, now = new Date()): Promise<void> {
  const row = await requireModeration(db, viewer, postId);
  const r = checkReason(reason);
  await db.update(forumPosts).set({ hiddenAt: now, hiddenBy: viewer.userId, hiddenReason: r }).where(eq(forumPosts.id, postId));
  // offene Meldungen zu diesem Beitrag sind damit erledigt
  await db.update(forumReports).set({ resolvedAt: now, resolvedBy: viewer.userId }).where(and(eq(forumReports.postId, postId), isNull(forumReports.resolvedAt)));
  await audit(db, viewer.userId, "foren.hide", postId, { topic: row.post.topicId, reason: r });
}

export async function unhidePost(db: Db, viewer: PermissionSet, postId: string): Promise<void> {
  const row = await requireModeration(db, viewer, postId);
  await db.update(forumPosts).set({ hiddenAt: null, hiddenBy: null, hiddenReason: null }).where(eq(forumPosts.id, postId));
  await audit(db, viewer.userId, "foren.unhide", postId, { topic: row.post.topicId });
}

/** Thema sperren bzw. entsperren: gesperrte Themen nehmen keine Antworten an. */
export async function setTopicLocked(db: Db, viewer: PermissionSet, topicId: string, locked: boolean): Promise<void> {
  const access = await topicWithAccess(db, viewer, topicId);
  if (!access || !canModerate(viewer, access.topic.groupId)) throw new ForbiddenError("foren.moderate");
  await db.update(forumTopics).set({ locked }).where(eq(forumTopics.id, topicId));
  await audit(db, viewer.userId, locked ? "foren.lock" : "foren.unlock", topicId, {});
}

/** Zuständige für ein Forum: Leitung der Gruppe und alle mit „foren.moderate“. */
async function moderatorsOf(db: Db, groupId: string | null): Promise<string[]> {
  const ids = new Set(await usersWithPermission(db, "foren.moderate"));
  if (groupId) {
    const leaders = await db.select({ id: groupMembers.userId }).from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "leader")));
    leaders.forEach((l) => ids.add(l.id));
  }
  return [...ids];
}

/** Melden: alle, die das Forum lesen; einmal je Person und Beitrag; Gong an die Moderation. */
export async function reportPost(db: Db, viewer: PermissionSet, postId: string, reason: string, now = new Date()): Promise<void> {
  const row = await postWithTopic(db, postId);
  if (!row || !(await topicWithAccess(db, viewer, row.post.topicId))) throw new ForbiddenError("foren.read");
  const r = checkReason(reason);
  const [dup] = await db
    .select()
    .from(forumReports)
    .where(and(eq(forumReports.postId, postId), eq(forumReports.reporterId, viewer.userId), isNull(forumReports.resolvedAt)));
  if (dup) throw new ValidationError({ reason: "Du hast diesen Beitrag schon gemeldet" });
  await db.insert(forumReports).values({ postId, reporterId: viewer.userId, reason: r, createdAt: now });
  const to = (await moderatorsOf(db, row.groupId)).filter((id) => id !== viewer.userId);
  if (to.length) await notify(db, to, { moduleId: "foren", title: `Gemeldeter Beitrag: ${row.topicTitle}`, body: r, href: "/foren/meldungen" });
}

/** Offene Meldungen aus den Foren, die der Betrachter moderiert. */
export async function openReports(db: Db, viewer: PermissionSet) {
  const all = hasPermission(viewer, "foren.moderate");
  if (!all && viewer.leaderOf.size === 0) return [];
  const reporter = users;
  const rows = await db
    .select({
      id: forumReports.id,
      reason: forumReports.reason,
      createdAt: forumReports.createdAt,
      reporterName: reporter.name,
      postId: forumPosts.id,
      body: forumPosts.body,
      hiddenAt: forumPosts.hiddenAt,
      topicId: forumTopics.id,
      topicTitle: forumTopics.title,
      groupId: forumTopics.groupId,
      groupName: groups.name,
    })
    .from(forumReports)
    .innerJoin(forumPosts, eq(forumPosts.id, forumReports.postId))
    .innerJoin(forumTopics, eq(forumTopics.id, forumPosts.topicId))
    .leftJoin(groups, eq(groups.id, forumTopics.groupId))
    .leftJoin(reporter, eq(reporter.id, forumReports.reporterId))
    .where(and(isNull(forumReports.resolvedAt), all ? undefined : inArray(forumTopics.groupId, [...viewer.leaderOf])))
    .orderBy(desc(forumReports.createdAt));
  return rows.map((r) => ({ ...r, forumName: r.groupId ? (r.groupName ?? "?") : "Kollegium", forumKey: r.groupId ?? KOLLEGIUM }));
}

/** Meldung verwerfen (Beitrag bleibt sichtbar). Ausblenden erledigt alle Meldungen eines Beitrags (hidePost). */
export async function dismissReport(db: Db, viewer: PermissionSet, reportId: string, now = new Date()): Promise<void> {
  const [rep] = await db.select().from(forumReports).where(eq(forumReports.id, reportId));
  if (!rep) throw new ForbiddenError("foren.moderate");
  await requireModeration(db, viewer, rep.postId);
  await db.update(forumReports).set({ resolvedAt: now, resolvedBy: viewer.userId }).where(eq(forumReports.id, reportId));
  await audit(db, viewer.userId, "foren.report.dismiss", rep.postId, {});
}
