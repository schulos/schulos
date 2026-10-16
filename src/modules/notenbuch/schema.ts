// Notenbuch (P5-10) – nur relative Imports (drizzle-kit).
// Arbeitsnotenbuch der Fachlehrkraft (Anlage 2 II Nr. 4 VO-DV I). Sichtbarkeit regelt ausschließlich der Service (service.ts):
// Teilnoten nur die Lehrkräfte in `notenbuch_book_teachers`, Halbjahreswerte zusätzlich Klassenleitung/`notenbuch.term_view`.
import { sql } from "drizzle-orm";
import { check, date, doublePrecision, index, integer, jsonb, pgEnum, pgSequence, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sessions, users } from "../../core/db/schema-auth";
import { groups, schoolYears, subjects } from "../../core/db/schema-core";
import { exams } from "../klausurplan/schema";
import { timetableAssignments } from "../stundenplan/schema";
import { COLUMN_KINDS, SCALES, type GradeKey, type Weights } from "./berechnung";

export const notenbuchScaleEnum = pgEnum("notenbuch_scale", SCALES);
export const notenbuchColumnKindEnum = pgEnum("notenbuch_column_kind", COLUMN_KINDS);

/**
 * Ein Notenbuch: Lerngruppe × Fach × Schuljahr × Halbjahr. `assignment_id` verweist auf den Lehrauftrag, aus dem es entstand
 * (optional – Lehraufträge können sich ändern, das Buch bleibt). Gesperrt (`locked_at`) nach dem Halbjahresabschluss (P5-13).
 */
export const notenbuchBooks = pgTable(
  "notenbuch_books",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    schoolYearId: text("school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "cascade" }),
    /** Halbjahr 1 oder 2 */
    term: integer("term").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => subjects.id, { onUpdate: "cascade" }),
    assignmentId: text("assignment_id").references(() => timetableAssignments.id, { onDelete: "set null" }),
    scale: notenbuchScaleEnum("scale").notNull(),
    /** Gewichte je Spaltenart in % (Summe ≠ 100 erlaubt, wird normiert) */
    weights: jsonb("weights").$type<Weights>().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("notenbuch_books_term", sql`${t.term} in (1, 2)`),
    uniqueIndex("notenbuch_books_unique").on(t.schoolYearId, t.term, t.groupId, t.subjectId),
    index("notenbuch_books_group_idx").on(t.groupId),
  ],
);

export type NotenbuchBook = typeof notenbuchBooks.$inferSelect;

/** Lehrkräfte eines Buchs – alle gleichberechtigt (F5-13). Vertretungen kommen nur per Übertragung hinein. */
export const notenbuchBookTeachers = pgTable(
  "notenbuch_book_teachers",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => notenbuchBooks.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.teacherId] }), index("notenbuch_book_teachers_teacher_idx").on(t.teacherId)],
);

/**
 * Spalte eines Buchs (Klassenarbeit, Test, mündliche Note …). Mit `max_points` werden Punkte eingegeben und per
 * `points_to_grade` (Prozentgrenzen, Vorgabe aus berechnung.ts) in eine Note umgerechnet.
 */
export const notenbuchColumns = pgTable(
  "notenbuch_columns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    bookId: text("book_id")
      .notNull()
      .references(() => notenbuchBooks.id, { onDelete: "cascade" }),
    kind: notenbuchColumnKindEnum("kind").notNull(),
    title: text("title").notNull(),
    date: date("date"),
    /** Gewicht innerhalb der Art (100 = einfach, 0 = zählt nicht) */
    weight: integer("weight").notNull().default(100),
    maxPoints: doublePrecision("max_points"),
    pointsToGrade: jsonb("points_to_grade").$type<GradeKey>(),
    examId: text("exam_id").references(() => exams.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("notenbuch_columns_weight", sql`${t.weight} between 0 and 1000`),
    check("notenbuch_columns_max_points", sql`${t.maxPoints} is null or (${t.maxPoints} > 0 and ${t.maxPoints} <= 1000)`),
    index("notenbuch_columns_book_idx").on(t.bookId),
  ],
);

export type NotenbuchColumn = typeof notenbuchColumns.$inferSelect;

/**
 * GATE-5a (G5A-C02): Revisionen der Zellen kommen aus einer Sequenz – monoton auch über Löschen und Neuanlage hinweg (eine
 * gelöschte und neu befüllte Zelle bekommt nie wieder eine alte Revision, eine veraltete Grundrevision kollidiert also immer).
 */
export const notenbuchEntryRevision = pgSequence("notenbuch_entry_revision");

/**
 * Eine Teilnote: Wert (Stufe der Skala, Punkte bei Spalten mit Höchstpunktzahl, „fehlt“, „befreit“) und Kurzkommentar.
 * `version` ist die Revision der Zelle (`notenbuch_entry_revision`, bei jeder Änderung neu; leere Zelle = 0) – Grundlage für
 * die Versionsprüfung online und den Abgleich der Offline-Eingabe (P5-20).
 */
export const notenbuchEntries = pgTable(
  "notenbuch_entries",
  {
    columnId: text("column_id")
      .notNull()
      .references(() => notenbuchColumns.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    comment: text("comment"),
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.columnId, t.studentId] }),
    check("notenbuch_entries_comment", sql`${t.comment} is null or char_length(${t.comment}) <= 200`),
    check("notenbuch_entries_value", sql`char_length(${t.value}) between 1 and 10`),
    index("notenbuch_entries_student_idx").on(t.studentId),
  ],
);

/**
 * Halbjahreswert je Person und Buch: berechneter Vorschlag (`computed`) und von der Lehrkraft festgelegte Note (`final`).
 * Nur diese Werte sehen Klassenleitung und `notenbuch.term_view` (F5-05).
 */
export const notenbuchTermGrades = pgTable(
  "notenbuch_term_grades",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => notenbuchBooks.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    computed: text("computed"),
    final: text("final"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: text("finalized_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.studentId] }), index("notenbuch_term_grades_student_idx").on(t.studentId)],
);

/**
 * Inaktivitätsablauf nur fürs Notenbuch (P5-12, Vordruck B1 „Sperre nach max. 15 min“; 4e verallgemeinert das mit P4-71):
 * letzte Aktivität je Sitzung im Notenbuch. Ist sie zu alt oder die Sitzung ausdrücklich gesperrt (`locked_at`), zeigen
 * Notenbuch-Seiten nur noch die Sperre, und Actions/Export werden abgelehnt – entsperrt wird nur über eine neue Anmeldung
 * (neue Sitzung). Geht mit der Sitzung (Fremdschlüssel, Kaskade).
 */
export const notenbuchSessions = pgTable("notenbuch_sessions", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
});

/**
 * Datenschutzhinweis beim ersten Öffnen (P5-17, F5-14): wer das Notenbuch nutzt, bestätigt den Hinweis einmal je Fassung
 * (`version`, siehe hinweis.ts). Erst danach zeigen Notenbuch-Seiten Inhalte und laufen Actions/Export. Nachweis, dass die
 * Person informiert wurde – geht mit dem Konto (Fremdschlüssel, Kaskade).
 */
export const notenbuchNoticeAcks = pgTable("notenbuch_notice_acks", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Offline-Eingabe auf Dienstgeräten (P5-20): je Gerät (Kennung vom Browser erzeugt) der **Server-Schlüsselanteil** des
 * verschlüsselten IndexedDB-Caches. Der Cache-Schlüssel entsteht erst im Browser aus diesem Anteil und einem nicht
 * exportierbaren Geräteanteil (offline-crypto.ts) – ohne diese Zeile ist der Cache unlesbar. GATE-5a (G5A-C01): gehört Person +
 * Gerät; `session_id` merkt sich nur die Sitzung, die das Gerät zuletzt genutzt hat – echtes Abmelden dort löscht die Zeile
 * (logoutAction), die Neuanmeldung nach der 15-Minuten-Sperre nicht (Sitzung weg → `session_id` leer, die neue Sitzung bindet
 * neu). Eigene Frist (`expires_at`, nächtlicher Lauf räumt ab). `reason`: womit das Gerät eingeschaltet wurde (G5A-C05).
 */
export const notenbuchOfflineDevices = pgTable(
  "notenbuch_offline_devices",
  {
    /** Gerätekennung aus dem Browser (zufällige UUID, ohne Personenbezug) */
    deviceId: text("device_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    /** 32 zufällige Bytes, Base64 – nur hier, nie im Browser gespeichert */
    serverShare: text("server_share").notNull(),
    /** Grund beim Einschalten: „zertifikat“ (Gerätezertifikat) oder „schulnetz“ (Bestätigung im Schulnetz) */
    reason: text("reason").notNull().default("zertifikat"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  },
  (t) => [index("notenbuch_offline_devices_user_idx").on(t.userId), index("notenbuch_offline_devices_session_idx").on(t.sessionId)],
);
