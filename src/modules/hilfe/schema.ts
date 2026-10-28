// Handbuch (HB-01, docs/HANDBUCH.md) – nur relative Imports (drizzle-kit).
// Zwei Ebenen: Bereich → Seite. Personenbezug nur über Ansprechperson und Bearbeiter:in (folgen dem Konto, `set null`);
// Seiten selbst werden nie automatisch gelöscht. Später (HB-05/HB-06): `hilfe_attachments`, `hilfe_revisions`.
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { roleEnum, users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const HILFE_PAGE_STATUS = ["entwurf", "veroeffentlicht"] as const;
export type HilfePageStatus = (typeof HILFE_PAGE_STATUS)[number];
export const hilfePageStatusEnum = pgEnum("hilfe_page_status", HILFE_PAGE_STATUS);

/** Bereiche (erste Gliederungsebene) – ohne Personenbezug. */
export const hilfeSections = pgTable("hilfe_sections", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const hilfePages = pgTable(
  "hilfe_pages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Bereich mit Seiten lässt sich nicht löschen (erst Seiten verschieben bzw. löschen)
    sectionId: text("section_id")
      .notNull()
      .references(() => hilfeSections.id, { onDelete: "restrict" }),
    /** sprechende Adresse `/hilfe/<slug>` – Ziel für Verlinkung zwischen Seiten (und später Kontexthilfe, HB-07) */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** Markdown */
    body: text("body").notNull().default(""),
    position: integer("position").notNull().default(0),
    status: hilfePageStatusEnum("status").notNull().default("entwurf"),
    /** Ansprechperson (HB-04): darf die Seite bearbeiten, bekommt die Erinnerung zur Überprüfung */
    contactId: text("contact_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** zuletzt geprüft (Speichern oder „geprüft, unverändert“) – Überprüfung fällig nach der Frist der Moduleinstellung */
    reviewedOn: date("reviewed_on").notNull(),
    /** Erinnerung zur Überprüfung verschickt (genau einmal je Frist, zurückgesetzt beim nächsten Prüfen) */
    reviewRemindedAt: timestamp("review_reminded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("hilfe_pages_slug_uq").on(t.slug),
    index("hilfe_pages_section_idx").on(t.sectionId, t.position),
    index("hilfe_pages_contact_idx").on(t.contactId),
    // Volltextsuche (HB-03) auf Titel und Text
    index("hilfe_pages_fts_idx").using("gin", sql`to_tsvector('german', ${t.title} || ' ' || ${t.body})`),
  ],
);

/** Zielgruppen einer Seite (wie bei News). Keine Zeile = an alle. */
export const hilfeTargets = pgTable(
  "hilfe_targets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => hilfePages.id, { onDelete: "cascade" }),
    role: roleEnum("role"),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [
    check("hilfe_targets_one", sql`(${t.role} is null) <> (${t.groupId} is null)`),
    uniqueIndex("hilfe_targets_role_uq").on(t.pageId, t.role),
    uniqueIndex("hilfe_targets_group_uq").on(t.pageId, t.groupId),
  ],
);

export type HilfePage = typeof hilfePages.$inferSelect;
export type HilfeSection = typeof hilfeSections.$inferSelect;
