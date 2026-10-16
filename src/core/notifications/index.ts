// „Gong": Benachrichtigungen speichern, lesen, als gelesen markieren – und live verteilen.
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { notifications } from "@/core/db/schema";
import { publish, type GongItem } from "./bus";

export type { GongItem } from "./bus";

export interface NotifyInput {
  moduleId: string;
  title: string;
  body?: string | null;
  href?: string | null;
}

function toItem(r: typeof notifications.$inferSelect): GongItem {
  return {
    id: r.id,
    moduleId: r.moduleId,
    title: r.title,
    body: r.body,
    href: r.href,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

/** Benachrichtigt mehrere Personen (doppelte IDs werden ignoriert) und pusht live. */
export async function notify(db: Db, userIds: readonly string[], n: NotifyInput): Promise<number> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return 0;
  const rows = await db
    .insert(notifications)
    .values(unique.map((userId) => ({ userId, moduleId: n.moduleId, title: n.title, body: n.body ?? null, href: n.href ?? null })))
    .returning();
  await Promise.all(
    rows.map(async (r) => publish(r.userId, { type: "notification", unread: await unreadCount(db, r.userId), notification: toItem(r) })),
  );
  return rows.length;
}

/**
 * Gebündelter Gong (Q5-03): je Person höchstens eine Nachricht mit diesem `bundleKey`. Gibt es sie schon, wird sie mit dem
 * neuen Inhalt ersetzt, wieder ungelesen und nach oben sortiert (neuer Zeitpunkt); sonst neu angelegt. Inhalt je Person.
 */
export async function notifyBundled(
  db: Db,
  items: readonly { userId: string; title: string; body?: string | null; href?: string | null }[],
  opts: { moduleId: string; bundleKey: string },
): Promise<number> {
  const byUser = new Map(items.map((i) => [i.userId, i]));
  if (byUser.size === 0) return 0;
  const now = new Date();
  const rows = await db
    .insert(notifications)
    .values([...byUser.values()].map((i) => ({ userId: i.userId, moduleId: opts.moduleId, title: i.title, body: i.body ?? null, href: i.href ?? null, bundleKey: opts.bundleKey, createdAt: now })))
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.bundleKey],
      set: { title: sql`excluded.title`, body: sql`excluded.body`, href: sql`excluded.href`, readAt: null, createdAt: now },
    })
    .returning();
  await Promise.all(
    rows.map(async (r) => publish(r.userId, { type: "notification", unread: await unreadCount(db, r.userId), notification: toItem(r) })),
  );
  return rows.length;
}

export async function listNotifications(db: Db, userId: string, limit = 20): Promise<GongItem[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
  return rows.map(toItem);
}

/** Markiert eigene Benachrichtigungen als gelesen (`ids` weglassen = alle). */
export async function markRead(db: Db, userId: string, ids?: readonly string[]): Promise<number> {
  const conds = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (ids) {
    if (ids.length === 0) return unreadCount(db, userId);
    conds.push(inArray(notifications.id, [...ids]));
  }
  await db.update(notifications).set({ readAt: new Date() }).where(and(...conds));
  const unread = await unreadCount(db, userId);
  publish(userId, { type: "read", unread });
  return unread;
}
