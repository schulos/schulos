// Dateien – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { bigint, check, index, pgEnum, pgTable, text, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const fileKindEnum = pgEnum("file_kind", ["folder", "file"]);

/** Ordner und Dateien. Bereich = persönlich (ownerId) ODER Gruppe (groupId). */
export const fileNodes = pgTable(
  "file_nodes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: fileKindEnum("kind").notNull(),
    name: text("name").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => fileNodes.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mime: text("mime"),
    storageKey: text("storage_key"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("file_nodes_space", sql`(${t.ownerId} is null) <> (${t.groupId} is null)`),
    check("file_nodes_storage", sql`(${t.kind} = 'file') = (${t.storageKey} is not null)`),
    index("file_nodes_parent_idx").on(t.parentId),
    index("file_nodes_owner_idx").on(t.ownerId),
    index("file_nodes_group_idx").on(t.groupId),
  ],
);
