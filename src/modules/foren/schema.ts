// Foren (P3-06/07) – nur relative Imports (drizzle-kit).
// Ein Forum je Gruppe (Gruppenmerkmal „foren.forum“) plus das Kollegiumsforum (group_id leer).
import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const forumTopics = pgTable(
  "foren_topics",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** leer = Kollegiumsforum */
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** Moderation (P3-07): gesperrte Themen nehmen keine Antworten an */
    locked: boolean("locked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastPostAt: timestamp("last_post_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("foren_topics_group_idx").on(t.groupId, t.lastPostAt)],
);

export const forumPosts = pgTable(
  "foren_posts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    topicId: text("topic_id")
      .notNull()
      .references(() => forumTopics.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    /** Markdown wie bei News */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** Moderation (P3-07): ausgeblendet mit Grund */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    hiddenBy: text("hidden_by").references(() => users.id, { onDelete: "set null" }),
    hiddenReason: text("hidden_reason"),
  },
  (t) => [index("foren_posts_topic_idx").on(t.topicId, t.createdAt)],
);

/** Abo eines Themas: Gong bei neuen Antworten. Wer ein Thema startet oder antwortet, abonniert es. */
export const forumSubscriptions = pgTable(
  "foren_subscriptions",
  {
    topicId: text("topic_id")
      .notNull()
      .references(() => forumTopics.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.topicId, t.userId] })],
);

/** Meldungen (P3-07): jede:r kann einen Beitrag melden; Moderation blendet aus oder verwirft. */
export const forumReports = pgTable(
  "foren_reports",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    postId: text("post_id")
      .notNull()
      .references(() => forumPosts.id, { onDelete: "cascade" }),
    reporterId: text("reporter_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("foren_reports_open_idx").on(t.resolvedAt)],
);
