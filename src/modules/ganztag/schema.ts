// Ganztag – Anwesenheitslisten (GT-01, docs/GANZTAG.md) – nur relative Imports (drizzle-kit).
// Serien und Gruppeneinstellungen ohne Personenbezug; Termine (LK-SJ ab Datum) tragen die Erfassung, die Markierungen
// gehen mit ihrem Termin (Kaskade) bzw. mit dem Konto der Schüler:in. Keine Gründe, kein Freitext.
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, schoolYears } from "../../core/db/schema-core";

// Neue Werte nur hinten anfügen: Postgres sortiert Enums nach Deklaration.
export const GANZTAG_SESSION_STATUS = ["geplant", "ausgefallen", "erfasst"] as const;
export type GanztagSessionStatus = (typeof GANZTAG_SESSION_STATUS)[number];
export const ganztagSessionStatusEnum = pgEnum("ganztag_session_status", GANZTAG_SESSION_STATUS);

export const GANZTAG_MARK_STATUS = ["anwesend", "fehlt", "verspaetet"] as const;
export type GanztagMarkStatus = (typeof GANZTAG_MARK_STATUS)[number];
export const ganztagMarkStatusEnum = pgEnum("ganztag_mark_status", GANZTAG_MARK_STATUS);

/** entschuldigt? `offen` = noch nicht geklärt (Abgleich mit Abwesenheiten: GT-04) */
export const GANZTAG_EXCUSED = ["offen", "ja", "nein"] as const;
export type GanztagExcused = (typeof GANZTAG_EXCUSED)[number];
export const ganztagExcusedEnum = pgEnum("ganztag_excused", GANZTAG_EXCUSED);

/** Herkunft einer Markierung: Klick der Leitung, Schalter „alle anwesend“, Vorbelegung aus den Abwesenheiten (GT-04) */
export const GANZTAG_MARK_SOURCE = ["leitung", "alle_anwesend", "abwesenheiten"] as const;
export type GanztagMarkSource = (typeof GANZTAG_MARK_SOURCE)[number];
export const ganztagMarkSourceEnum = pgEnum("ganztag_mark_source", GANZTAG_MARK_SOURCE);

/** Einstellungen je Angebot (Gruppe mit Merkmal `ganztag.liste`) – ohne Personenbezug. */
export const ganztagGroupSettings = pgTable("ganztag_group_settings", {
  groupId: text("group_id")
    .primaryKey()
    .references(() => groups.id, { onDelete: "cascade" }),
  /** verpflichtendes Angebot: unentschuldigtes Fehlen geht gebündelt an die Klassenleitung (GT-04) */
  mandatory: boolean("mandatory").notNull().default(false),
  /** Klassenleitung benachrichtigen (GT-04) */
  notifyClassLead: boolean("notify_class_lead").notNull().default(true),
  /** „entschuldigt“ aus Krankmeldung/Beurlaubung vorbelegen (GT-04) */
  prefillAbsences: boolean("prefill_absences").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Wöchentliche Terminserie einer Gruppe (Wochentag + Zeit, gültig von/bis) – ohne Personenbezug. */
export const ganztagSeries = pgTable(
  "ganztag_series",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    schoolYearId: text("school_year_id").references(() => schoolYears.id, { onDelete: "set null" }),
    /** 0 = Montag … 4 = Freitag */
    weekday: integer("weekday").notNull(),
    /** „14:00“ (Berliner Ortszeit) */
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ganztag_series_weekday", sql`${t.weekday} between 0 and 4`),
    check("ganztag_series_time", sql`${t.endsAt} > ${t.startsAt}`),
    check("ganztag_series_valid", sql`${t.validTo} >= ${t.validFrom}`),
    index("ganztag_series_group_idx").on(t.groupId),
  ],
);

/** Termine (aus einer Serie oder einzeln angelegt). Personenbezug nur über „erfasst von“ und die Markierungen. */
export const ganztagSessions = pgTable(
  "ganztag_sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    /** null = Einzeltermin bzw. Serie gelöscht (erfasste Termine bleiben) */
    seriesId: text("series_id").references(() => ganztagSeries.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    status: ganztagSessionStatusEnum("status").notNull().default("geplant"),
    /** Schalter „alle anwesend“: alle ohne eigene Markierung gelten als anwesend (als Markierung mit Herkunft `alle_anwesend`) */
    allPresent: boolean("all_present").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    recordedBy: text("recorded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ganztag_sessions_time", sql`${t.endsAt} > ${t.startsAt}`),
    uniqueIndex("ganztag_sessions_slot_uq").on(t.groupId, t.date, t.startsAt),
    index("ganztag_sessions_date_idx").on(t.date),
    index("ganztag_sessions_series_idx").on(t.seriesId),
  ],
);

/** Anwesenheit je Termin und Schüler:in – ohne Grund, ohne Freitext. */
export const ganztagMarks = pgTable(
  "ganztag_marks",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => ganztagSessions.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: ganztagMarkStatusEnum("status").notNull(),
    /** nur bei „verspätet“ */
    minutesLate: integer("minutes_late"),
    excused: ganztagExcusedEnum("excused").notNull().default("offen"),
    source: ganztagMarkSourceEnum("source").notNull().default("leitung"),
    recordedBy: text("recorded_by").references(() => users.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.studentId] }),
    check("ganztag_marks_late", sql`${t.minutesLate} is null or (${t.status} = 'verspaetet' and ${t.minutesLate} between 1 and 240)`),
    index("ganztag_marks_student_idx").on(t.studentId),
  ],
);

export type GanztagSession = typeof ganztagSessions.$inferSelect;
export type GanztagSeries = typeof ganztagSeries.$inferSelect;
