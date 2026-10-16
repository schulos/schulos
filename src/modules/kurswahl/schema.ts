// Kurswahlen (P4-60) – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, schoolYears, subjects } from "../../core/db/schema-core";

/** Arten einer Wahl – bestimmen nur Beschriftung und die Gruppenart bei der Übernahme (`KIND_GROUP` im Service). */
export const KURSWAHL_KINDS = ["wp1", "wp2", "religion_pp", "fremdsprache", "ag", "ef_fachwahl", "sonstiges"] as const;
export type KurswahlKind = (typeof KURSWAHL_KINDS)[number];

/** Wer gibt die Wahl ab: die Eltern (für Minderjährige) oder die Schüler:in selbst. Volljährige wählen immer selbst. */
export const KURSWAHL_CHOOSERS = ["eltern", "schueler"] as const;
export type KurswahlChooser = (typeof KURSWAHL_CHOOSERS)[number];

/**
 * Ein Wahlverfahren: Zielgruppe (Jahrgang, optional einzelne Klassen), Zeitraum, Anzahl der Wünsche, wer wählt. Die
 * Zuteilung (Seed des Loses) und die Übernahme in Gruppen werden hier festgehalten.
 */
export const kurswahlVerfahren = pgTable(
  "kurswahl_verfahren",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    kind: text("kind").$type<KurswahlKind>().notNull(),
    /** Hinweis an die Familien (Freitext der Schule, z. B. Infoabend, Fristen) */
    note: text("note"),
    /** Jahrgang der Wählenden (grade_levels.level) */
    gradeLevel: integer("grade_level").notNull(),
    /** nur diese Klassen (groups.id, Art „klasse“); leer = alle Klassen des Jahrgangs */
    classIds: text("class_ids").array().notNull().default(sql`'{}'::text[]`),
    /** Jahrgang der entstehenden Gruppen (bei der Wahl im Vorjahr: der nächste) */
    courseGrade: integer("course_grade").notNull(),
    /** Schuljahr der entstehenden Gruppen und Lehraufträge */
    schoolYearId: text("school_year_id").references(() => schoolYears.id, { onDelete: "set null" }),
    /** Wahlzeitraum (einschließlich) */
    opensOn: date("opens_on").notNull(),
    closesOn: date("closes_on").notNull(),
    /** Anzahl der Wünsche (1.–3. Priorität) – je Platz */
    choices: integer("choices").notNull().default(3),
    /** P4-67 Mehrfachwahl: so viele Kurse wählt jede Person mindestens bzw. höchstens („Plätze“, je Platz eigene Wünsche) */
    minCourses: integer("min_courses").notNull().default(1),
    maxCourses: integer("max_courses").notNull().default(1),
    chooser: text("chooser").$type<KurswahlChooser>().notNull().default("eltern"),
    /** nur bei `chooser = schueler`: Eltern minderjähriger Kinder bestätigen die Wahl mit einem Häkchen */
    parentConfirm: boolean("parent_confirm").notNull().default(false),
    /** Seed des Loses der letzten Zuteilung (protokolliert) */
    allocationSeed: text("allocation_seed"),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }),
    /** Übernahme in Gruppen erledigt – danach ist die Zuteilung fest und für die Familien sichtbar */
    transferredAt: timestamp("transferred_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    /** P4-66: automatische Erinnerung zwei Tage vor Wahlende verschickt (Tag) – einmal je Verfahren */
    autoRemindedOn: date("auto_reminded_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("kurswahl_verfahren_range", sql`${t.closesOn} >= ${t.opensOn}`),
    check("kurswahl_verfahren_choices", sql`${t.choices} between 1 and 3`),
    check("kurswahl_verfahren_courses", sql`${t.minCourses} >= 1 and ${t.maxCourses} >= ${t.minCourses} and ${t.maxCourses} <= 6`),
    index("kurswahl_verfahren_closes_idx").on(t.closesOn),
  ],
);

export type KurswahlVerfahren = typeof kurswahlVerfahren.$inferSelect;

/** Ein wählbares Angebot (Fach/Kurs) mit Kapazität und Mindestgröße; Lehrkraft und Stunden für den Lehrauftrag-Vorschlag. */
export const kurswahlAngebote = pgTable(
  "kurswahl_angebote",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    verfahrenId: text("verfahren_id")
      .notNull()
      .references(() => kurswahlVerfahren.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    subjectId: text("subject_id").references(() => subjects.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** Kursniveau (LEVEL_LABELS), optional */
    level: text("level"),
    /** Mindestgröße: darunter fällt das Angebot bei der Zuteilung aus (0 = keine) */
    minSize: integer("min_size").notNull().default(0),
    /** Höchstzahl; leer = unbegrenzt */
    maxSize: integer("max_size"),
    note: text("note"),
    /** vorgesehene Lehrkraft (Gruppenleitung und Lehrauftrag-Vorschlag) */
    teacherId: text("teacher_id").references(() => users.id, { onDelete: "set null" }),
    /** Wochenstunden für den Lehrauftrag-Vorschlag */
    hours: integer("hours"),
    /** bei der Übernahme entstandene bzw. ergänzte Gruppe */
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    check("kurswahl_angebote_min", sql`${t.minSize} >= 0`),
    check("kurswahl_angebote_max", sql`${t.maxSize} is null or (${t.maxSize} >= 1 and ${t.maxSize} >= ${t.minSize})`),
    check("kurswahl_angebote_hours", sql`${t.hours} is null or ${t.hours} between 1 and 12`),
    index("kurswahl_angebote_verfahren_idx").on(t.verfahrenId),
  ],
);

export type KurswahlAngebot = typeof kurswahlAngebote.$inferSelect;

/**
 * Wahl einer Schüler:in (eine Zeile je Person, Verfahren und Platz): Wünsche als Angebots-IDs in Reihenfolge der Priorität,
 * wer sie abgegeben (und ggf. bestätigt) hat, und das Ergebnis der Zuteilung mit Begründung. P4-67: bei Mehrfachwahl je
 * Platz eine Zeile (Platz 1 immer zuerst; Abgabe und Bestätigung stehen in allen Zeilen der Person gleich).
 */
export const kurswahlWahlen = pgTable(
  "kurswahl_wahlen",
  {
    verfahrenId: text("verfahren_id")
      .notNull()
      .references(() => kurswahlVerfahren.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** P4-67: Platz (1 … Höchstzahl der Kurse) */
    place: integer("place").notNull().default(1),
    /** Angebots-IDs, 1. Wunsch zuerst; leer = ohne Wahl (Zeile nur für eine Zuteilung von Hand) */
    choices: text("choices").array().notNull().default(sql`'{}'::text[]`),
    submittedBy: text("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    assignedId: text("assigned_id").references(() => kurswahlAngebote.id, { onDelete: "set null" }),
    /** erfüllter Wunsch (1–3); leer = Restplatz bzw. von Hand */
    assignedRank: integer("assigned_rank"),
    /** Begründung der Zuteilung in einem Satz */
    reason: text("reason"),
    /** von Hand zugeteilt (bleibt bei einer neuen Zuteilung erhalten) */
    manual: boolean("manual").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.verfahrenId, t.studentId, t.place] }),
    index("kurswahl_wahlen_student_idx").on(t.studentId),
    check("kurswahl_wahlen_place", sql`${t.place} between 1 and 6`),
  ],
);

export type KurswahlWahl = typeof kurswahlWahlen.$inferSelect;
