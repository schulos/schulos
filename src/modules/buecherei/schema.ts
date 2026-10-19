// Schulbücherei – Bestand ohne Personenbezug (BU-01), Ausleihen (BU-02). Nur relative Imports (drizzle-kit).
import { date, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "../../core/db/schema-auth";
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

/**
 * Ausleihe (BU-02). Personenbezug nur, solange sie offen ist: Die Rückgabe ohne Befund löscht die Zeile (es bleibt nur der
 * Zähler in `buecherei_stats`) – kein Ausleihverlauf je Person. Rückgabe mit Befund (Schaden, unvollständig) behält die Zeile
 * bis zur Erledigung + LK-SJ-1J. Kontolöschung leert `user_id` (offene Ausleihe bleibt als „Konto gelöscht“ sichtbar).
 */
export const buechereiLoans = pgTable(
  "buecherei_loans",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    copyId: text("copy_id")
      .notNull()
      .references(() => buechereiCopies.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    loanedOn: date("loaned_on").notNull(),
    dueOn: date("due_on").notNull(),
    renewals: integer("renewals").notNull().default(0),
    /** nur bei Rückgabe mit Befund gesetzt – ohne Befund wird die Zeile gelöscht */
    returnedOn: date("returned_on"),
    /** Befund bei der Rückgabe (Sache, keine Namen), z. B. „Wasserschaden“, „CD fehlt“ */
    finding: text("finding"),
    findingResolvedOn: date("finding_resolved_on"),
    /** BU-04: Fälligkeit, an die schon erinnert wurde (Verlängern verschiebt die Fälligkeit → neue Erinnerung) */
    remindedDueOn: date("reminded_due_on"),
    /** BU-04: Mahnstufe 0–3 – lebt nur mit der offenen Ausleihe (Rückgabe löscht bzw. setzt zurück, Verlängern setzt zurück) */
    dunningLevel: integer("dunning_level").notNull().default(0),
    /** BU-04: Tag der letzten Mahnung (nächste Stufe frühestens nach dem eingestellten Abstand) */
    dunnedOn: date("dunned_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ein Exemplar ist höchstens einmal gleichzeitig ausgeliehen
    uniqueIndex("buecherei_loans_open_copy_idx").on(t.copyId).where(sql`${t.returnedOn} is null`),
    index("buecherei_loans_user_idx").on(t.userId),
  ],
);

/** Ausleihzahlen je Monat und Medienart – ohne Personenbezug (Statistik, BU-05). */
export const buechereiStats = pgTable(
  "buecherei_stats",
  {
    /** „2026-10“ */
    month: text("month").notNull(),
    mediaType: buechereiMediaTypeEnum("media_type").notNull(),
    loans: integer("loans").notNull().default(0),
    renewals: integer("renewals").notNull().default(0),
    /** BU-04: verschickte Mahnungen (alle Stufen) – nur gezählt, ohne Person */
    dunnings: integer("dunnings").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.month, t.mediaType] })],
);

/**
 * Büchereiausweis (BU-07): je Konto höchstens ein pseudonymer, zufälliger Code (`K-` + 10 Zeichen) – keine Namen, keine
 * Kontonummer darin. Ersatz bei Verlust löscht den alten Code. Gehört zum Konto (LK-KONTO, Kaskade).
 */
export const buechereiCards = pgTable("buecherei_cards", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Vormerkung (BU-03): Person wartet auf einen Titel, dessen Exemplare alle ausgeliehen sind; Reihenfolge nach `created_at`.
 * Kommt ein Exemplar zurück, wird die erste wartende Vormerkung „bereit“ (`ready_on`, Abholfrist `hold_until`, Gong). Die
 * Ausleihe an die Person erfüllt sie (Zeile weg), abgelaufene Abholfrist oder Löschen durch die Person ebenso – kein Verlauf.
 * Spätestens nach LK-90 gelöscht; geht mit dem Konto (Kaskade).
 */
export const buechereiReservations = pgTable(
  "buecherei_reservations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    titleId: text("title_id")
      .notNull()
      .references(() => buechereiTitles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Tag, an dem ein Exemplar für die Person zurückgelegt wurde (Gong); bis dahin wartend */
    readyOn: date("ready_on"),
    /** letzter Abholtag; danach verfällt die Vormerkung und die nächste rückt nach */
    holdUntil: date("hold_until"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("buecherei_reservations_title_user_idx").on(t.titleId, t.userId), index("buecherei_reservations_user_idx").on(t.userId)],
);
