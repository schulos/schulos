// Buchungen – nur relative Imports (drizzle-kit).
import { boolean, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, periods, rooms } from "../../core/db/schema-core";

export const RESOURCE_KINDS = ["room", "device"] as const;
export const resourceKindEnum = pgEnum("booking_resource_kind", RESOURCE_KINDS);

/** Buchbare Räume (Verweis auf Stammdaten) und Geräte (Laptopwagen, iPad-Koffer …). */
export const bookingResources = pgTable("booking_resources", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  kind: resourceKindEnum("kind").notNull(),
  roomId: text("room_id")
    .unique()
    .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
});

export const bookings = pgTable(
  "bookings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    periodNr: integer("period_nr")
      .notNull()
      .references(() => periods.nr),
    bookedBy: text("booked_by").references(() => users.id, { onDelete: "set null" }),
    /** für welche Klasse/welchen Kurs (optional) */
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bookings_slot_uq").on(t.resourceId, t.date, t.periodNr), index("bookings_date_idx").on(t.date)],
);

export type BookingResource = typeof bookingResources.$inferSelect;
