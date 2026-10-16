// News – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { roleEnum, users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const newsPosts = pgTable(
  "news_posts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** Markdown */
    body: text("body").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    /** im Laufband der Statusmonitore zeigen (nur Beiträge an alle bzw. an Lehrkräfte im Lehrerzimmer) */
    onMonitor: boolean("on_monitor").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("news_posts_published_idx").on(t.publishedAt)],
);

/** Zielgruppen eines Beitrags. Keine Zeile = an alle. */
export const newsTargets = pgTable(
  "news_targets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    postId: text("post_id")
      .notNull()
      .references(() => newsPosts.id, { onDelete: "cascade" }),
    role: roleEnum("role"),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [
    check("news_targets_one", sql`(${t.role} is null) <> (${t.groupId} is null)`),
    uniqueIndex("news_targets_role_uq").on(t.postId, t.role),
    uniqueIndex("news_targets_group_uq").on(t.postId, t.groupId),
  ],
);
