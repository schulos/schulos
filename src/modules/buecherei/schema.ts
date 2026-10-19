// Schulbücherei (BU-01) – Bestand ohne Personenbezug. Nur relative Imports (drizzle-kit).
import { date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { COPY_CONDITIONS, MEDIA_TYPES } from "./labels";

export const buechereiMediaTypeEnum = pgEnum("buecherei_media_type", MEDIA_TYPES);
export const buechereiConditionEnum = pgEnum("buecherei_condition", COPY_CONDITIONS);

/** Titel (bibliografische Angaben). ISBN als ISBN-13 normalisiert, je Titel höchstens einmal. */
export const buechereiTitles = pgTable(
  "buecherei_titles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    author: text("author"),
    isbn: text("isbn"),
    publisher: text("publisher"),
    year: integer("year"),
    keywords: text("keywords"),
    /** Altersempfehlung „ab … Jahren“ */
    ageFrom: integer("age_from"),
    mediaType: buechereiMediaTypeEnum("media_type").notNull().default("buch"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("buecherei_titles_isbn_idx").on(t.isbn).where(sql`${t.isbn} is not null`)],
);

/**
 * Exemplar mit Exemplarnummer (= Barcode, `B-004711-3`: Präfix, laufende Nummer, Prüfziffer). Ausgesonderte Exemplare
 * bleiben mit Datum und Grund stehen (Nachweis für den Bestand), sind aber nicht mehr ausleihbar.
 */
export const buechereiCopies = pgTable(
  "buecherei_copies",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    titleId: text("title_id")
      .notNull()
      .references(() => buechereiTitles.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    barcode: text("barcode").notNull().unique(),
    signature: text("signature"),
    location: text("location"),
    condition: buechereiConditionEnum("condition").notNull().default("gut"),
    withdrawnOn: date("withdrawn_on"),
    withdrawnReason: text("withdrawn_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("buecherei_copies_title_idx").on(t.titleId), uniqueIndex("buecherei_copies_seq_idx").on(t.seq)],
);
