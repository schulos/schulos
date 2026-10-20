// Schulbücherei – Bestand ohne Personenbezug (BU-01), Ausleihen (BU-02). Nur relative Imports (drizzle-kit).
import { boolean, check, date, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "../../core/db/schema-auth";
import { gradeLevels, schoolYears, subjects } from "../../core/db/schema-core";
import { COMPENSATION_STATUSES, COPY_CONDITIONS, MATERIAL_PROVISIONS, MEDIA_TYPES } from "./labels";

export const buechereiMediaTypeEnum = pgEnum("buecherei_media_type", MEDIA_TYPES);
export const buechereiConditionEnum = pgEnum("buecherei_condition", COPY_CONDITIONS);
export const buechereiProvisionEnum = pgEnum("buecherei_material_provision", MATERIAL_PROVISIONS);
export const buechereiCompensationStatusEnum = pgEnum("buecherei_compensation_status", COMPENSATION_STATUSES);

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
    /** BU-05: Etikett gedruckt am – leer = Exemplar steht in der Druckwarteschlange */
    labelPrintedAt: timestamp("label_printed_at", { withTimezone: true }),
    /** BU-05: Zahl der Ausleihen dieses Exemplars (Statistik „nie ausgeliehen“, Aussonderungsvorschläge) – ohne Person */
    loanCount: integer("loan_count").notNull().default(0),
    /** BU-05: Monat der letzten Ausleihe („2026-10“) – nur der Monat, ohne Person */
    lastLoanMonth: text("last_loan_month"),
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

// ---------------------------------------------------------------- Stufe 2: Schulbuchausleihe (BU-10, Schalter `buecherei.lernmittel`)

/**
 * Lernmittel (Schulbuch, Arbeitsheft, Atlas …) mit Zuordnung zu Jahrgängen, Fach und optional Kurs/Zweig. `provision`: leiht
 * die Schule aus (Exemplare mit Inventarnummer) oder kaufen die Familien selbst (Bücherliste mit Preis). Kein Personenbezug.
 * Nicht mehr verwendete Lernmittel werden archiviert (`archived_on`), nicht gelöscht, solange es Exemplare gibt.
 */
export const buechereiTeachingMaterials = pgTable(
  "buecherei_teaching_materials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    author: text("author"),
    isbn: text("isbn"),
    publisher: text("publisher"),
    subjectId: text("subject_id").references(() => subjects.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** Jahrgänge (grade_levels.level), in denen das Lernmittel gebraucht wird, z. B. {5,6} */
    grades: integer("grades").array().notNull(),
    /** Kurs/Zweig, wenn nicht die ganze Jahrgangsstufe es braucht, z. B. „E-Kurs“, „Französisch“, „bilingual“ */
    course: text("course"),
    provision: buechereiProvisionEnum("provision").notNull().default("leihe"),
    /** Ladenpreis in Cent (Bücherliste bei „selbst kaufen“; Grundlage einer späteren Ersatzforderung, BU-12) */
    priceCents: integer("price_cents"),
    note: text("note"),
    archivedOn: date("archived_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("buecherei_teaching_materials_isbn_idx").on(t.isbn).where(sql`${t.isbn} is not null`),
    check("buecherei_teaching_materials_price", sql`${t.priceCents} is null or ${t.priceCents} between 0 and 99999`),
  ],
);

/**
 * Exemplar eines Lernmittels mit Inventarnummer (`L-000042-7`, eigener Nummernkreis, Prüfziffer) und Zustand; Zustandsvermerk
 * nur zur Sache (keine Namen). Wem es im laufenden Schuljahr gehört, steht nicht hier, sondern ab BU-11 in einer eigenen
 * Zuordnung (nur im laufenden Schuljahr, Rücknahme ohne Befund löscht sie). Kein Personenbezug.
 */
export const buechereiMaterialCopies = pgTable(
  "buecherei_material_copies",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    materialId: text("material_id")
      .notNull()
      .references(() => buechereiTeachingMaterials.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    inventoryNumber: text("inventory_number").notNull().unique(),
    condition: buechereiConditionEnum("condition").notNull().default("neu"),
    /** Zustandsvermerk zur Sache, z. B. „Einband lose“ – keine Namen */
    conditionNote: text("condition_note"),
    /** Jahr der Anschaffung (Nutzungsdauer, Aussonderung) */
    acquiredYear: integer("acquired_year"),
    withdrawnOn: date("withdrawn_on"),
    withdrawnReason: text("withdrawn_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("buecherei_material_copies_material_idx").on(t.materialId), uniqueIndex("buecherei_material_copies_seq_idx").on(t.seq)],
);

/** Bücherliste je Jahrgang: Hinweistext für Eltern (Abgabe, Eigenanteil, Umschläge …); die Lernmittel kommen aus der Zuordnung. */
export const buechereiBooklists = pgTable("buecherei_booklists", {
  gradeLevel: integer("grade_level")
    .primaryKey()
    .references(() => gradeLevels.level, { onDelete: "cascade" }),
  text: text("text").notNull().default(""),
  /** Liste für Eltern freigegeben (sonst sehen sie nur Verwaltung/Lernmittel-Team) */
  published: boolean("published").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ausgabe eines Schulbuchs (BU-11): Zuordnung Exemplar ↔ Person für ein Schuljahr (`school_year_id`, laufendes Schuljahr bei der
 * Ausgabe), fällig zum Ende dieses Schuljahres. Löschregel (docs/BUECHEREI.md „Stufe 2 – Festlegungen“ 4): Rücknahme **ohne**
 * Befund löscht die Zeile sofort (kein Verlauf, der Zustand steht am Exemplar ohne Person); Rücknahme **mit** Befund bleibt bis
 * zur Erledigung (BU-12), danach LK-SJ-1J. Nicht Zurückgegebenes bleibt über das Schuljahresende nur als offener Posten und geht
 * spätestens mit dem Konto (Kontolöschung leert die Person). Mahnstufe wie in Stufe 1, lebt nur mit der offenen Ausgabe.
 */
export const buechereiMaterialIssues = pgTable(
  "buecherei_material_issues",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    copyId: text("copy_id")
      .notNull()
      .references(() => buechereiMaterialCopies.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Schuljahr der Ausgabe – die Zuordnung gilt nur dafür */
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "restrict" }),
    issuedOn: date("issued_on").notNull(),
    /** Rückgabe bis (Ende des Schuljahres der Ausgabe) */
    dueOn: date("due_on").notNull(),
    /** nur bei Rücknahme mit Befund gesetzt – ohne Befund wird die Zeile gelöscht */
    returnedOn: date("returned_on"),
    /** Befund bei der Rücknahme (Sache, keine Namen), z. B. „Wasserschaden“ – Grundlage einer Ersatzforderung (BU-12) */
    finding: text("finding"),
    findingResolvedOn: date("finding_resolved_on"),
    /** Mahnstufe 0–3 nach Ablauf der Rückgabefrist (Eltern Minderjähriger ab der 1. Stufe, Entscheidung 4) */
    dunningLevel: integer("dunning_level").notNull().default(0),
    dunnedOn: date("dunned_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ein Exemplar ist höchstens einmal gleichzeitig ausgegeben
    uniqueIndex("buecherei_material_issues_open_copy_idx").on(t.copyId).where(sql`${t.returnedOn} is null`),
    index("buecherei_material_issues_user_idx").on(t.userId),
    index("buecherei_material_issues_year_idx").on(t.schoolYearId),
  ],
);

/**
 * Ersatzforderung (BU-12): Betrag und Grund für einen Schaden oder Verlust – aus einer Rückgabe mit Befund (Stufe 1, `loan_id`),
 * einer Schulbuch-Rücknahme mit Befund oder einem nicht zurückgegebenen Schulbuch (`issue_id`). Nur erfassen und Brief
 * erzeugen, keine Zahlungsabwicklung. Status offen/bezahlt/erlassen; mit dem Abschluss ist der Befund erledigt. Offen: mit dem
 * Konto (Kontolöschung leert die Person); abgeschlossen: LK-SJ-1J ab `closed_on`.
 */
export const buechereiCompensations = pgTable(
  "buecherei_compensations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    loanId: text("loan_id").references(() => buechereiLoans.id, { onDelete: "set null" }),
    issueId: text("issue_id").references(() => buechereiMaterialIssues.id, { onDelete: "set null" }),
    /** Gegenstand als Text (Titel + Exemplar-/Inventarnummer) – bleibt lesbar, auch wenn die Ausleihe schon gelöscht ist */
    item: text("item").notNull(),
    /** Grund (Sache, keine Namen), z. B. „Wasserschaden“, „nicht zurückgegeben“ */
    reason: text("reason").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: buechereiCompensationStatusEnum("status").notNull().default("offen"),
    createdOn: date("created_on").notNull(),
    /** bezahlt bzw. erlassen am */
    closedOn: date("closed_on"),
    /** zuletzt als Brief gedruckt am */
    letterOn: date("letter_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("buecherei_compensations_amount", sql`${t.amountCents} between 1 and 99999`),
    uniqueIndex("buecherei_compensations_loan_idx").on(t.loanId).where(sql`${t.loanId} is not null`),
    uniqueIndex("buecherei_compensations_issue_idx").on(t.issueId).where(sql`${t.issueId} is not null`),
    index("buecherei_compensations_user_idx").on(t.userId),
  ],
);
