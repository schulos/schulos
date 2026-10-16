// Messenger: Direktchats + Gruppenräume (Gruppenmerkmal), Echtzeit über den Live-Bus.
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { chatMembers, chatMessages, chatReads, chatRooms, groupFeatures, groupMembers, groups, users } from "@/core/db/schema";
import { publish } from "@/core/notifications/bus";
import type { PermissionSet } from "@/core/permissions";
import { visiblePeople } from "@/modules/adressbuch/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { directChatBlock } from "./policy";

export const GROUP_ROOM_FEATURE = "messenger.raum";
const MAX_LEN = 4000;

/** Legt fehlende Gruppenräume für die Gruppen des Betrachters an (Merkmal aktiv). */
async function ensureGroupRooms(db: Db, viewer: PermissionSet) {
  if (viewer.memberOf.size === 0) return;
  const gs = await db
    .select({ id: groupFeatures.groupId })
    .from(groupFeatures)
    .where(and(eq(groupFeatures.feature, GROUP_ROOM_FEATURE), inArray(groupFeatures.groupId, [...viewer.memberOf])));
  if (gs.length) await db.insert(chatRooms).values(gs.map((g) => ({ kind: "group" as const, groupId: g.id }))).onConflictDoNothing();
}

/** IDs der Räume, auf die der Betrachter Zugriff hat. */
async function accessibleRoomIds(db: Db, viewer: PermissionSet): Promise<string[]> {
  const direct = await db.select({ id: chatMembers.roomId }).from(chatMembers).where(eq(chatMembers.userId, viewer.userId));
  const group = viewer.memberOf.size
    ? await db
        .select({ id: chatRooms.id })
        .from(chatRooms)
        .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, chatRooms.groupId), eq(groupFeatures.feature, GROUP_ROOM_FEATURE)))
        .where(inArray(chatRooms.groupId, [...viewer.memberOf]))
    : [];
  return [...direct, ...group].map((r) => r.id);
}

/** Raum-id des Gruppenchats (legt ihn an, falls nötig); null ohne Mitgliedschaft oder ohne aktives Merkmal. */
export async function groupRoomId(db: Db, viewer: PermissionSet, groupId: string): Promise<string | null> {
  if (!viewer.memberOf.has(groupId)) return null;
  const [f] = await db.select().from(groupFeatures).where(and(eq(groupFeatures.groupId, groupId), eq(groupFeatures.feature, GROUP_ROOM_FEATURE)));
  if (!f) return null;
  await db.insert(chatRooms).values({ kind: "group", groupId }).onConflictDoNothing();
  const [room] = await db.select({ id: chatRooms.id }).from(chatRooms).where(eq(chatRooms.groupId, groupId));
  return room?.id ?? null;
}

export async function canAccess(db: Db, viewer: PermissionSet, roomId: string) {
  return (await accessibleRoomIds(db, viewer)).includes(roomId);
}

/** Mitglieder eines Raums (für Zustellung und Lesestatus). */
export async function roomMemberIds(db: Db, roomId: string): Promise<string[]> {
  const [room] = await db.select().from(chatRooms).where(eq(chatRooms.id, roomId));
  if (!room) return [];
  if (room.kind === "direct") return (await db.select({ id: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.roomId, roomId))).map((r) => r.id);
  return (await db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, room.groupId!))).map((r) => r.id);
}

async function unreadByRoom(db: Db, viewer: PermissionSet, roomIds: string[]) {
  if (roomIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ roomId: chatMessages.roomId, n: sql<number>`count(*)::int` })
    .from(chatMessages)
    .leftJoin(chatReads, and(eq(chatReads.roomId, chatMessages.roomId), eq(chatReads.userId, viewer.userId)))
    .where(
      and(
        inArray(chatMessages.roomId, roomIds),
        or(isNull(chatMessages.authorId), ne(chatMessages.authorId, viewer.userId)),
        or(isNull(chatReads.lastReadAt), gt(chatMessages.createdAt, chatReads.lastReadAt)),
      ),
    )
    .groupBy(chatMessages.roomId);
  return new Map(rows.map((r) => [r.roomId, r.n]));
}

export async function unreadTotal(db: Db, viewer: PermissionSet): Promise<number> {
  const m = await unreadByRoom(db, viewer, await accessibleRoomIds(db, viewer));
  return [...m.values()].reduce((a, b) => a + b, 0);
}

/** Klasse 7b → „7B“, AG Schülerzeitung → „AS“, Fachschaft Deutsch → „FD“ */
function groupAvatar(kind: string | null, slug: string | null, name: string | null): string {
  if (kind === "klasse" && slug) return slug.toUpperCase().slice(0, 3);
  const words = (name ?? "?").split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export interface RoomSummary {
  id: string;
  kind: "direct" | "group";
  title: string;
  /** Kürzel/Initialen bzw. Gruppenkurzname für den Avatar */
  avatar: string;
  lastMessage: { body: string; authorName: string | null; createdAt: Date } | null;
  unread: number;
}

/** Raumliste, zuletzt aktive zuerst. */
export async function listRooms(db: Db, viewer: PermissionSet): Promise<RoomSummary[]> {
  await ensureGroupRooms(db, viewer);
  const ids = await accessibleRoomIds(db, viewer);
  if (ids.length === 0) return [];
  const [rooms, others, unread] = await Promise.all([
    db
      .select({ id: chatRooms.id, kind: chatRooms.kind, groupName: groups.name, groupSlug: groups.slug, groupKind: groups.kind, lastMessageAt: chatRooms.lastMessageAt, createdAt: chatRooms.createdAt })
      .from(chatRooms)
      .leftJoin(groups, eq(groups.id, chatRooms.groupId))
      .where(inArray(chatRooms.id, ids)),
    db
      .select({ roomId: chatMembers.roomId, name: users.name, shortCode: users.shortCode, firstName: users.firstName, lastName: users.lastName })
      .from(chatMembers)
      .innerJoin(users, eq(users.id, chatMembers.userId))
      .where(and(inArray(chatMembers.roomId, ids), ne(chatMembers.userId, viewer.userId))),
    unreadByRoom(db, viewer, ids),
  ]);
  const last = await db.execute<{ room_id: string; body: string; author_name: string | null; created_at: string }>(sql`
    select distinct on (m.room_id) m.room_id, m.body, u.name as author_name, m.created_at
    from chat_messages m left join users u on u.id = m.author_id
    where m.room_id in ${ids}
    order by m.room_id, m.created_at desc`);
  const lastRows = rowsOf<{ room_id: string; body: string; author_name: string | null; created_at: string }>(last);
  const sortAt = new Map(rooms.map((r) => [r.id, (r.lastMessageAt ?? r.createdAt).getTime()]));
  return rooms
    .map((r): RoomSummary => {
      const other = others.find((o) => o.roomId === r.id);
      const lm = lastRows.find((l) => l.room_id === r.id);
      return {
        id: r.id,
        kind: r.kind,
        title: r.kind === "group" ? (r.groupName ?? "Gruppe") : (other?.name ?? "Unbekannt"),
        avatar: r.kind === "group" ? groupAvatar(r.groupKind, r.groupSlug, r.groupName) : (other?.shortCode ?? `${other?.firstName?.[0] ?? ""}${other?.lastName?.[0] ?? ""}`),
        lastMessage: lm ? { body: lm.body, authorName: lm.author_name, createdAt: new Date(lm.created_at) } : null,
        unread: unread.get(r.id) ?? 0,
      };
    })
    .sort((a, b) => sortAt.get(b.id)! - sortAt.get(a.id)!);
}

/** Direktchat öffnen (anlegen, falls neu). Nur mit Personen, die man sehen darf. */
/** Für Direktchats: gilt die Chat-Regel (Moduleinstellungen) zwischen Betrachter und Gegenüber noch? */
export async function directPartnerBlock(db: Db, viewer: PermissionSet, roomId: string): Promise<string | null> {
  const other = await directPartner(db, viewer, roomId);
  return other ? directChatBlock(db, { id: viewer.userId, role: viewer.role }, other) : null;
}

/** Gegenüber in einem Direktchat (null bei Gruppenchats). */
export async function directPartner(db: Db, viewer: PermissionSet, roomId: string) {
  const [room] = await db.select({ kind: chatRooms.kind }).from(chatRooms).where(eq(chatRooms.id, roomId));
  if (room?.kind !== "direct") return null;
  const [other] = await db
    .select({ id: users.id, role: users.role })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(and(eq(chatMembers.roomId, roomId), ne(chatMembers.userId, viewer.userId)));
  return other ?? null;
}

export async function openDirectRoom(db: Db, viewer: PermissionSet, otherId: string): Promise<string> {
  if (otherId === viewer.userId) throw new ValidationError({ user: "Mit dir selbst chatten geht nicht" });
  const [other] = await db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.id, otherId), await visiblePeople(db, viewer)));
  if (!other) throw new ValidationError({ user: "Person nicht gefunden" });
  const directKey = [viewer.userId, otherId].sort().join("|");
  const [existing] = await db.select({ id: chatRooms.id }).from(chatRooms).where(eq(chatRooms.directKey, directKey));
  const blocked = await directChatBlock(db, { id: viewer.userId, role: viewer.role }, other, { initiating: !existing });
  if (blocked) throw new ValidationError({ user: blocked });
  if (existing) return existing.id;
  const [room] = await db.insert(chatRooms).values({ kind: "direct", directKey }).returning({ id: chatRooms.id });
  await db.insert(chatMembers).values([
    { roomId: room!.id, userId: viewer.userId },
    { roomId: room!.id, userId: otherId },
  ]);
  return room!.id;
}

export async function getRoom(db: Db, viewer: PermissionSet, roomId: string) {
  if (!(await canAccess(db, viewer, roomId))) return null;
  const summary = (await listRooms(db, viewer)).find((r) => r.id === roomId)!;
  const memberIds = await roomMemberIds(db, roomId);
  const reads = await db.select().from(chatReads).where(eq(chatReads.roomId, roomId));
  return { ...summary, memberCount: memberIds.length, reads: reads.filter((r) => r.userId !== viewer.userId).map((r) => ({ userId: r.userId, lastReadAt: r.lastReadAt })) };
}

export async function listMessages(db: Db, viewer: PermissionSet, roomId: string, limit = 100) {
  if (!(await canAccess(db, viewer, roomId))) return null;
  const rows = await db
    .select({ id: chatMessages.id, roomId: chatMessages.roomId, authorId: chatMessages.authorId, authorName: users.name, body: chatMessages.body, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.authorId))
    .where(eq(chatMessages.roomId, roomId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit);
  return rows.reverse();
}

export async function sendMessage(db: Db, viewer: PermissionSet, roomId: string, rawBody: string) {
  const body = rawBody.trim();
  if (!body) throw new ValidationError({ body: "Leere Nachricht" });
  if (body.length > MAX_LEN) throw new ValidationError({ body: `Höchstens ${MAX_LEN} Zeichen` });
  if (!(await canAccess(db, viewer, roomId))) throw new ValidationError({ body: "Kein Zugriff" });
  const blocked = await directPartnerBlock(db, viewer, roomId);
  if (blocked) throw new ValidationError({ body: blocked });
  const [msg] = await db.insert(chatMessages).values({ roomId, authorId: viewer.userId, body }).returning();
  await db.update(chatRooms).set({ lastMessageAt: msg!.createdAt }).where(eq(chatRooms.id, roomId));
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId));
  const event = {
    type: "chat" as const,
    message: { id: msg!.id, roomId, authorId: viewer.userId, authorName: me?.name ?? null, body, createdAt: msg!.createdAt.toISOString() },
  };
  for (const uid of await roomMemberIds(db, roomId)) publish(uid, event);
  // Reihenfolge wichtig: das chat-read-Ereignis mit unreadTotal muss NACH dem chat-Ereignis kommen,
  // sonst zählt der Client die eigene Nachricht als ungelesen.
  await markRead(db, viewer, roomId, msg!.createdAt, false);
  return event.message;
}

/** Lesestand setzen; meldet allen im Raum den neuen Stand (für „Gelesen"). */
export async function markRead(db: Db, viewer: PermissionSet, roomId: string, at = new Date(), check = true) {
  if (check && !(await canAccess(db, viewer, roomId))) return;
  await db
    .insert(chatReads)
    .values({ roomId, userId: viewer.userId, lastReadAt: at })
    .onConflictDoUpdate({ target: [chatReads.roomId, chatReads.userId], set: { lastReadAt: sql`greatest(${chatReads.lastReadAt}, excluded.last_read_at)` } });
  const total = await unreadTotal(db, viewer);
  for (const uid of await roomMemberIds(db, roomId)) {
    publish(uid, { type: "chat-read", roomId, userId: viewer.userId, lastReadAt: at.toISOString(), ...(uid === viewer.userId ? { unreadTotal: total } : {}) });
  }
}

