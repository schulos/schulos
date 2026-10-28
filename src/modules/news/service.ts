// News – schwarzes Brett mit Zielgruppen.
import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, groups, newsPosts, newsTargets, users, ROLES, type Role } from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { audienceGroups, targetedTo } from "@/core/school/audience";
import { parentLinks } from "@/core/school/majority";
import { notify } from "@/core/notifications";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";

export const canWrite = (p: PermissionSet) => hasPermission(p, "news.write");
export const canManage = (p: PermissionSet) => hasPermission(p, "news.manage");

async function visibility(db: Db, viewer: PermissionSet): Promise<SQL | undefined> {
  if (canManage(viewer)) return undefined;
  const targets = { table: newsTargets, owner: newsTargets.postId, role: newsTargets.role, groupId: newsTargets.groupId };
  return or(eq(newsPosts.authorId, viewer.userId), targetedTo(db, targets, newsPosts.id, viewer, await audienceGroups(db, viewer)));
}

const notExpired = (now: Date) => or(isNull(newsPosts.expiresAt), gt(newsPosts.expiresAt, now));

export interface NewsListItem {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  onMonitor: boolean;
  publishedAt: Date;
  expiresAt: Date | null;
  authorId: string | null;
  authorName: string | null;
  targets: string[];
}

async function withTargets(db: Db, rows: Omit<NewsListItem, "targets">[]): Promise<NewsListItem[]> {
  if (rows.length === 0) return [];
  const t = await db
    .select({ postId: newsTargets.postId, role: newsTargets.role, groupName: groups.name })
    .from(newsTargets)
    .leftJoin(groups, eq(groups.id, newsTargets.groupId))
    .where(inArray(newsTargets.postId, rows.map((r) => r.id)));
  return rows.map((r) => ({
    ...r,
    targets: t.filter((x) => x.postId === r.id).map((x) => (x.role ? ROLE_LABELS[x.role] : (x.groupName ?? "?"))),
  }));
}

const baseSelect = {
  id: newsPosts.id,
  title: newsPosts.title,
  body: newsPosts.body,
  pinned: newsPosts.pinned,
  onMonitor: newsPosts.onMonitor,
  publishedAt: newsPosts.publishedAt,
  expiresAt: newsPosts.expiresAt,
  authorId: newsPosts.authorId,
  authorName: users.name,
};

export async function listPosts(
  db: Db,
  viewer: PermissionSet,
  opts: { limit?: number; includeExpired?: boolean; q?: string; now?: Date } = {},
): Promise<NewsListItem[]> {
  const now = opts.now ?? new Date();
  const conds: (SQL | undefined)[] = [await visibility(db, viewer)];
  if (!opts.includeExpired) conds.push(notExpired(now));
  const q = opts.q?.trim();
  if (q) {
    conds.push(sql`to_tsvector('german', ${newsPosts.title} || ' ' || ${newsPosts.body}) @@ websearch_to_tsquery('german', ${q})`);
  }
  const rows = await db
    .select(baseSelect)
    .from(newsPosts)
    .leftJoin(users, eq(users.id, newsPosts.authorId))
    .where(and(...conds))
    .orderBy(desc(newsPosts.pinned), desc(newsPosts.publishedAt))
    .limit(opts.limit ?? 50);
  return withTargets(db, rows);
}

export async function getPost(db: Db, viewer: PermissionSet, id: string) {
  const [row] = await db
    .select(baseSelect)
    .from(newsPosts)
    .leftJoin(users, eq(users.id, newsPosts.authorId))
    .where(and(eq(newsPosts.id, id), await visibility(db, viewer)));
  if (!row) return null;
  const [post] = await withTargets(db, [row]);
  const raw = await db.select({ role: newsTargets.role, groupId: newsTargets.groupId }).from(newsTargets).where(eq(newsTargets.postId, id));
  return {
    ...post!,
    targetRoles: raw.flatMap((r) => (r.role ? [r.role] : [])),
    targetGroupIds: raw.flatMap((r) => (r.groupId ? [r.groupId] : [])),
  };
}

export function canEdit(viewer: PermissionSet, post: { authorId: string | null }) {
  return canManage(viewer) || (canWrite(viewer) && post.authorId === viewer.userId);
}

export interface PostInput {
  title: string;
  body: string;
  pinned?: boolean;
  onMonitor?: boolean;
  expiresAt?: Date | null;
  targetRoles?: Role[];
  targetGroupIds?: string[];
  notify?: boolean;
}

function validate(input: PostInput) {
  const errors: Record<string, string> = {};
  if (!input.title.trim()) errors.title = "Titel fehlt";
  if (input.title.length > 140) errors.title = "Höchstens 140 Zeichen";
  if (!input.body.trim()) errors.body = "Text fehlt";
  if (input.expiresAt && input.expiresAt.getTime() < Date.now()) errors.expiresAt = "Ablaufdatum liegt in der Vergangenheit";
  if (input.targetRoles?.some((r) => !ROLES.includes(r))) errors.targets = "Unbekannte Rolle";
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

async function writeTargets(db: Db, postId: string, input: PostInput) {
  await db.delete(newsTargets).where(eq(newsTargets.postId, postId));
  const rows = [
    ...(input.targetRoles ?? []).map((role) => ({ postId, role })),
    ...[...new Set(input.targetGroupIds ?? [])].map((groupId) => ({ postId, groupId })),
  ];
  if (rows.length) await db.insert(newsTargets).values(rows);
}

/** Empfänger eines Beitrags (für den Gong): Rollen, Gruppenmitglieder + Eltern von Schüler:innen darin. */
export async function resolveAudience(db: Db, input: Pick<PostInput, "targetRoles" | "targetGroupIds">): Promise<string[]> {
  const roles = input.targetRoles ?? [];
  const gids = input.targetGroupIds ?? [];
  const active = eq(users.status, "active");
  if (roles.length === 0 && gids.length === 0) {
    return (await db.select({ id: users.id }).from(users).where(active)).map((r) => r.id);
  }
  const ids = new Set<string>();
  if (roles.length) (await db.select({ id: users.id }).from(users).where(and(inArray(users.role, roles), active))).forEach((r) => ids.add(r.id));
  if (gids.length) {
    const members = await db.select({ id: groupMembers.userId }).from(groupMembers).where(inArray(groupMembers.groupId, gids));
    members.forEach((m) => ids.add(m.id));
    const parents = await parentLinks(db, members.map((m) => m.id), "inform");
    parents.forEach((p) => ids.add(p.parentId));
  }
  return [...ids];
}

export async function createPost(db: Db, actor: PermissionSet, input: PostInput): Promise<string> {
  if (!canWrite(actor)) throw new ValidationError({ title: "Keine Berechtigung" });
  validate(input);
  const [post] = await db
    .insert(newsPosts)
    .values({
      authorId: actor.userId,
      title: input.title.trim(),
      body: input.body.trim(),
      pinned: canManage(actor) ? !!input.pinned : false,
      onMonitor: canManage(actor) ? !!input.onMonitor : false,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: newsPosts.id });
  await writeTargets(db, post!.id, input);
  if (input.notify) {
    const audience = (await resolveAudience(db, input)).filter((id) => id !== actor.userId);
    await notify(db, audience, { moduleId: "news", title: input.title.trim(), body: "Neuer Beitrag am schwarzen Brett", href: `/news/${post!.id}` });
  }
  return post!.id;
}

export async function updatePost(db: Db, actor: PermissionSet, id: string, input: PostInput): Promise<void> {
  const [existing] = await db.select({ authorId: newsPosts.authorId, pinned: newsPosts.pinned, onMonitor: newsPosts.onMonitor }).from(newsPosts).where(eq(newsPosts.id, id));
  if (!existing || !canEdit(actor, existing)) throw new ValidationError({ title: "Keine Berechtigung" });
  validate(input);
  await db
    .update(newsPosts)
    .set({
      title: input.title.trim(),
      body: input.body.trim(),
      pinned: canManage(actor) ? !!input.pinned : existing.pinned,
      onMonitor: canManage(actor) ? !!input.onMonitor : existing.onMonitor,
      expiresAt: input.expiresAt ?? null,
    })
    .where(eq(newsPosts.id, id));
  await writeTargets(db, id, input);
}

export async function deletePost(db: Db, actor: PermissionSet, id: string): Promise<void> {
  const [existing] = await db.select({ authorId: newsPosts.authorId }).from(newsPosts).where(eq(newsPosts.id, id));
  if (!existing || !canEdit(actor, existing)) throw new ValidationError({ title: "Keine Berechtigung" });
  await db.delete(newsPosts).where(eq(newsPosts.id, id));
}

export { targetableGroups } from "@/core/school/audience";
