// Messenger – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const chatRoomKindEnum = pgEnum("chat_room_kind", ["direct", "group"]);

export const chatRooms = pgTable(
  "chat_rooms",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: chatRoomKindEnum("kind").notNull(),
    /** Gruppenraum: genau einer pro Gruppe */
    groupId: text("group_id")
      .unique()
      .references(() => groups.id, { onDelete: "cascade" }),
    /** Direktchat: „userA|userB" (sortiert) – genau einer pro Paar */
    directKey: text("direct_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (t) => [check("chat_rooms_kind", sql`(${t.kind} = 'group') = (${t.groupId} is not null) and (${t.kind} = 'direct') = (${t.directKey} is not null)`)],
);

/** Mitglieder von Direktchats (Gruppenräume nutzen die Gruppenmitgliedschaft). */
export const chatMembers = pgTable(
  "chat_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index("chat_members_user_idx").on(t.userId)],
);

/** Lesestand je Person und Raum. */
export const chatReads = pgTable(
  "chat_reads",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roomId: text("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_room_idx").on(t.roomId, t.createdAt)],
);
