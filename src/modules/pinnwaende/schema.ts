// Pinnwände (P3-08/09) – nur relative Imports (drizzle-kit).
// Pinnwand einer Gruppe (Gruppenmerkmal „pinnwaende.board“, Mitglieder der Gruppe) oder frei mit eigenen Mitgliedern.
import { boolean, index, integer, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";
import { fileNodes } from "../dateien/schema";

/** Wer posten darf: nur Leitung, alle Mitglieder, alle mit Freigabe durch die Leitung */
export const BOARD_MODES = ["leitung", "alle", "moderiert"] as const;
export type BoardMode = (typeof BOARD_MODES)[number];
export const boardModeEnum = pgEnum("pinnwaende_mode", BOARD_MODES);

export const CARD_KINDS = ["text", "link", "file"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const cardKindEnum = pgEnum("pinnwaende_card_kind", CARD_KINDS);

export const boards = pgTable(
  "pinnwaende_boards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** gesetzt = Pinnwand einer Gruppe; leer = freie Pinnwand mit eigenen Mitgliedern */
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    mode: boardModeEnum("mode").notNull().default("alle"),
    /** P3-09: Leitung erlaubt die Anzeige auf Statusmonitoren (nur freigegebene Karten, ohne Namen und Bilder) */
    onMonitor: boolean("on_monitor").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pinnwaende_boards_group_idx").on(t.groupId)],
);

/** Mitglieder freier Pinnwände; „leader“ darf wie die Leitung einer Gruppe verwalten und freigeben. */
export const boardMembers = pgTable(
  "pinnwaende_members",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    leader: boolean("leader").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] }), index("pinnwaende_members_user_idx").on(t.userId)],
);

export const boardColumns = pgTable(
  "pinnwaende_columns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [index("pinnwaende_columns_board_idx").on(t.boardId, t.position)],
);

export const boardCards = pgTable(
  "pinnwaende_cards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    columnId: text("column_id")
      .notNull()
      .references(() => boardColumns.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    kind: cardKindEnum("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    url: text("url"),
    /** Datei aus dem Gruppenordner (nur Pinnwände einer Gruppe) */
    fileId: text("file_id").references(() => fileNodes.id, { onDelete: "set null" }),
    position: integer("position").notNull(),
    /** Modus „moderiert“: erst nach Freigabe für alle sichtbar */
    approved: boolean("approved").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pinnwaende_cards_column_idx").on(t.columnId, t.position)],
);
