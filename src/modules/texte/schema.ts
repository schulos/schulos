// Texte (P3-11) – nur relative Imports (drizzle-kit).
// Gemeinsam bearbeitete Texte einer Gruppe (Gruppenmerkmal „texte.doc“): der Inhalt ist ein Yjs-Dokument, gespeichert
// als vollständiger Stand (Yjs-Update v1, Base64). Kein Update-Protokoll – der Abgleich läuft über Zustandsvektoren.
import { index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

/** Wer schreibt: alle Mitglieder oder nur die Leitung (alle anderen lesen) */
export const TEXT_MODES = ["alle", "leitung"] as const;
export type TextMode = (typeof TEXT_MODES)[number];
export const textModeEnum = pgEnum("texte_mode", TEXT_MODES);

export const textDocs = pgTable(
  "texte_docs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    mode: textModeEnum("mode").notNull().default("alle"),
    /** Yjs-Stand (encodeStateAsUpdate, Base64); leer = noch kein Inhalt */
    state: text("state").notNull().default(""),
    /** steigt mit jedem Speichern – optimistische Sperre beim Zusammenführen mehrerer Prozesse */
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** letzte Inhaltsänderung bzw. Umbenennung – Beginn der Löschfrist */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("texte_docs_group_idx").on(t.groupId)],
);
