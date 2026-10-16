// Elternsprechtag (P4-50) – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { rooms } from "../../core/db/schema-core";

/** Pause im Raster, z. B. { from: "17:00", to: "17:20" } */
export interface SprechtagBreak {
  from: string;
  to: string;
}

/**
 * Ein Sprechtag (ein Datum, ein Zeitraster). Die Verwaltung legt ihn an; Eltern buchen nur im Buchungsfenster.
 * Ohne Personenbezug bis auf die angehängten Verfügbarkeiten und Termine – die gehen mit dem Sprechtag (Kaskade).
 */
export const sprechtagEvents = pgTable(
  "sprechtag_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    date: date("date").notNull(),
    /** „16:00“ (Berliner Ortszeit) */
    startsAt: text("starts_at").notNull(),
    /** „19:00“ – Ende des letzten Gesprächs */
    endsAt: text("ends_at").notNull(),
    /** Länge eines Gesprächs in Minuten (5–30) */
    slotMinutes: integer("slot_minutes").notNull(),
    breaks: jsonb("breaks").$type<SprechtagBreak[]>().notNull().default([]),
    /** Buchungsfenster für Eltern: erster und letzter Tag (einschließlich) */
    bookingOpensOn: date("booking_opens_on").notNull(),
    bookingClosesOn: date("booking_closes_on").notNull(),
    /** Erinnerung am Vortag verschickt (Job) */
    remindedOn: date("reminded_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sprechtag_events_slot", sql`${t.slotMinutes} between 5 and 30`),
    check("sprechtag_events_time", sql`${t.endsAt} > ${t.startsAt}`),
    check("sprechtag_events_booking", sql`${t.bookingClosesOn} >= ${t.bookingOpensOn}`),
    index("sprechtag_events_date_idx").on(t.date),
  ],
);

export type SprechtagEvent = typeof sprechtagEvents.$inferSelect;

/**
 * Lehrkraft nimmt teil: Raum und gesperrte Zeiten. Ohne Zeile ist die Lehrkraft nicht buchbar (sie gibt ihre Zeiten
 * selbst frei; Vorgabe beim Freigeben: alle Zeiten, Raum = Stammraum ihrer Klasse).
 */
export const sprechtagAvailability = pgTable(
  "sprechtag_availability",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => sprechtagEvents.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** nicht angebotene Zeiten („16:30“) */
    blockedSlots: text("blocked_slots").array().notNull().default(sql`'{}'::text[]`),
    releasedAt: timestamp("released_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.teacherId] }), index("sprechtag_availability_teacher_idx").on(t.teacherId)],
);

export type SprechtagAvailability = typeof sprechtagAvailability.$inferSelect;

/**
 * Gebuchter Termin: Lehrkraft × Schüler:in zu einer Zeit. Gebucht von einem Elternteil (handelt für ein minderjähriges
 * Kind) bzw. von der eigenständigen (volljährigen) Person selbst. Eine Absage löscht den Termin.
 */
export const sprechtagAppointments = pgTable(
  "sprechtag_appointments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id")
      .notNull()
      .references(() => sprechtagEvents.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookedBy: text("booked_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Beginn im Raster („16:30“) */
    slot: text("slot").notNull(),
    /** derselbe Beginn als Zeitpunkt (Sortierung, Erinnerung, Löschfrist) */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Lehrkraft nicht doppelt, Kind nicht doppelt zur selben Zeit, je Kind und Lehrkraft ein Gespräch
    uniqueIndex("sprechtag_appointments_teacher_slot").on(t.eventId, t.teacherId, t.slot),
    uniqueIndex("sprechtag_appointments_student_slot").on(t.eventId, t.studentId, t.slot),
    uniqueIndex("sprechtag_appointments_pair").on(t.eventId, t.teacherId, t.studentId),
    index("sprechtag_appointments_booker_idx").on(t.eventId, t.bookedBy),
    index("sprechtag_appointments_student_idx").on(t.studentId),
  ],
);

export type SprechtagAppointment = typeof sprechtagAppointments.$inferSelect;

/** Gesprächswunsch einer Lehrkraft an die Eltern einer Schülerin/eines Schülers (Gong/Mail an die Eltern). */
export const sprechtagInvitations = pgTable(
  "sprechtag_invitations",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => sprechtagEvents.id, { onDelete: "cascade" }),
    teacherId: text("teacher_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.teacherId, t.studentId] }), index("sprechtag_invitations_student_idx").on(t.studentId)],
);
