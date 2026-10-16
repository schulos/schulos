// Kalender – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { boolean, check, date, index, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const CALENDAR_SCOPES = ["personal", "group", "school"] as const;
export const calendarScopeEnum = pgEnum("calendar_scope", CALENDAR_SCOPES);

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Ganztägig: Mitternacht NACH dem letzten Tag (exklusiv) */
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    scope: calendarScopeEnum("scope").notNull(),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    /** Wöchentliche Wiederholung bis einschließlich dieses Datums (Berliner Kalendertag) */
    repeatWeeklyUntil: date("repeat_weekly_until"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("calendar_events_group", sql`(${t.scope} = 'group') = (${t.groupId} is not null)`),
    check("calendar_events_order", sql`${t.endsAt} >= ${t.startsAt}`),
    index("calendar_events_range_idx").on(t.startsAt, t.endsAt),
    index("calendar_events_group_idx").on(t.groupId),
  ],
);

/**
 * Kalender-Abo per geheimem Link (Q5-15): je Link ein Kalender der Person, nur lesend. Gespeichert wird nur der SHA-256 des
 * Tokens (256 bit Zufall, ohne Personenbezug); Widerruf = Zeile löschen. Unbenutzte Links verfallen nach einem Jahr (LK-1J).
 */
export const calendarFeedTokens = pgTable(
  "calendar_feed_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** „personal“, „school“ oder „group:<id>“ – bei jedem Abruf erneut gegen die lesbaren Kalender geprüft */
    calendar: text("calendar").notNull(),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("calendar_feed_tokens_hash_idx").on(t.tokenHash), index("calendar_feed_tokens_user_idx").on(t.userId)],
);
