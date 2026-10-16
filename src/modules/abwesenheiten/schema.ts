// Abwesenheiten – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { recordArchives } from "../../core/db/schema-core";

/** Bewusst nur zwei Gründe ohne Freitext – keine Gesundheitsdaten (Art. 9 DSGVO) */
export const ABSENCE_REASONS = ["krank", "sonstiges"] as const;
export const absenceReasonEnum = pgEnum("absence_reason", ABSENCE_REASONS);

export const ABSENCE_REPORT_STATUS = ["gemeldet", "entschuldigt", "nicht_entschuldigt"] as const;
export const absenceReportStatusEnum = pgEnum("absence_report_status", ABSENCE_REPORT_STATUS);

/** Meldung einer Abwesenheit (Eltern) bzw. erfasste Entschuldigung (Klassenleitung). */
export const absenceReports = pgTable(
  "absence_reports",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reportedBy: text("reported_by").references(() => users.id, { onDelete: "set null" }),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    reason: absenceReasonEnum("reason").notNull(),
    status: absenceReportStatusEnum("status").notNull().default("gemeldet"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * DS-16/G4D-S01: Archivexport (Klassenbuch), der diese Meldung im Teil „Entschuldigungen“ zuletzt enthielt, und wann.
     * Gelöscht wird erst, wenn genau dieser Export nach diesem Zeitpunkt als übergeben bestätigt ist.
     */
    archiveId: text("archive_id").references(() => recordArchives.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    check("absence_reports_range", sql`${t.toDate} >= ${t.fromDate}`),
    index("absence_reports_student_idx").on(t.studentId, t.fromDate),
    index("absence_reports_archive_idx").on(t.archiveId),
  ],
);

export type AbsenceReport = typeof absenceReports.$inferSelect;

/**
 * Beurlaubung vorab (Q5-16, F-08): Gründe bewusst als Auswahl ohne Freitext und ohne Art.-9-Bezug – keine Religion, keine
 * Gesundheit (familiär, Wettkampf/Veranstaltung, sonstiges).
 */
export const LEAVE_REASONS = ["familiaer", "veranstaltung", "sonstiges"] as const;
export const leaveReasonEnum = pgEnum("absence_leave_reason", LEAVE_REASONS);

export const LEAVE_STATUS = ["beantragt", "genehmigt", "abgelehnt"] as const;
export const leaveStatusEnum = pgEnum("absence_leave_status", LEAVE_STATUS);

/** Wer entscheidet – beim Antrag nach der Zahl der Schultage festgelegt (Moduleinstellung, Vorgabe bis 2 Tage KL). */
export const LEAVE_DECIDERS = ["klassenleitung", "schulleitung"] as const;
export const leaveDeciderEnum = pgEnum("absence_leave_decider", LEAVE_DECIDERS);

/** Antrag auf Beurlaubung (Eltern bzw. volljährige Schüler:innen). Genehmigt → Fehlstunden im Zeitraum „entschuldigt“ (beurlaubt). */
export const absenceLeaveRequests = pgTable(
  "absence_leave_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    /** Schultage im Zeitraum beim Antrag (ohne Wochenenden, Feiertage, Ferien) */
    schoolDays: integer("school_days").notNull(),
    reason: leaveReasonEnum("reason").notNull(),
    decider: leaveDeciderEnum("decider").notNull(),
    status: leaveStatusEnum("status").notNull().default("beantragt"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("absence_leave_requests_range", sql`${t.toDate} >= ${t.fromDate}`), index("absence_leave_requests_student_idx").on(t.studentId, t.fromDate)],
);

export type AbsenceLeaveRequest = typeof absenceLeaveRequests.$inferSelect;
