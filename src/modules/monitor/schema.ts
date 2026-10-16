// Statusmonitore – nur relative Imports (drizzle-kit).
import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { boards } from "../pinnwaende/schema";

export const MONITOR_PROFILES = ["foyer", "lehrerzimmer", "sprechtag"] as const;
export type MonitorProfile = (typeof MONITOR_PROFILES)[number];
export const monitorProfileEnum = pgEnum("monitor_profile", MONITOR_PROFILES);

/** Bildschirme im Foyer/Lehrerzimmer. Zugang über eine geheime Adresse; gespeichert wird nur der Hash des Tokens. */
export const monitorScreens = pgTable("monitor_screens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  location: text("location"),
  profile: monitorProfileEnum("profile").notNull().default("foyer"),
  /** P3-09: zusätzlich eine Pinnwand zeigen (nur Pinnwände, deren Leitung das erlaubt) */
  boardId: text("board_id").references(() => boards.id, { onDelete: "set null" }),
  /** SHA-256 des Tokens; leer = widerrufen */
  tokenHash: text("token_hash").unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MonitorScreen = typeof monitorScreens.$inferSelect;
