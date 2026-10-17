// Kursraum (V-01) – nur relative Imports (drizzle-kit).
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

/**
 * Link auf einen externen Konferenzraum je Gruppe (höchstens einer). Setzen dürfen Leitung und Gruppenverwaltung
 * (Service); sehen nur, wer den Kursraum öffnen darf – nur bei eingeschalteter Moduleinstellung `kurse.konferenz`.
 * Der Link kann ein Raum-Passwort enthalten: nicht in Suche, Monitor oder Exporten.
 */
export const kurseLinks = pgTable("kurse_links", {
  groupId: text("group_id")
    .primaryKey()
    .references(() => groups.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  label: text("label").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
