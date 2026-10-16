// Schulanmeldung (P4-32) – nur relative Imports (drizzle-kit).
import { boolean, check, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "../../core/db/schema-auth";
import { rooms, schoolYears } from "../../core/db/schema-core";
import { ANTRAG_STATUSES, EREIGNIS_KINDS, VERFAHREN_KINDS, VERFAHREN_STATUSES } from "./labels";

export const anmeldungKindEnum = pgEnum("anmeldung_kind", VERFAHREN_KINDS);
export const anmeldungVerfahrenStatusEnum = pgEnum("anmeldung_verfahren_status", VERFAHREN_STATUSES);
export const anmeldungAntragStatusEnum = pgEnum("anmeldung_antrag_status", ANTRAG_STATUSES);
export const anmeldungEreignisKindEnum = pgEnum("anmeldung_ereignis_kind", EREIGNIS_KINDS);

/** Anmeldeverfahren, z. B. „Anmeldung Klasse 5 – Schuljahr 2027/28“. */
export const anmeldungVerfahren = pgTable(
  "anmeldung_verfahren",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    kind: anmeldungKindEnum("kind").notNull(),
    targetSchoolYearId: text("target_school_year_id")
      .notNull()
      .references(() => schoolYears.id, { onDelete: "restrict" }),
    targetGradeLevel: integer("target_grade_level").notNull(),
    opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    /** Aufnahmekapazität (Plätze), optional – nur zur Information bei der Entscheidung */
    capacity: integer("capacity"),
    /** Hinweistext für Eltern (Unterlagen, Ablauf); Zeilenumbrüche, kein HTML */
    intro: text("intro").notNull().default(""),
    /** optionale Felder an/aus (OPTIONAL_FIELDS) */
    fields: jsonb("fields").notNull().default({}),
    /** Löschfrist abgelehnter/Wartelisten-Anträge ab Verfahrensabschluss in Tagen (Q-36: Vorgabe 60, höchstens 365) */
    rejectKeepDays: integer("reject_keep_days").notNull().default(60),
    status: anmeldungVerfahrenStatusEnum("status").notNull().default("entwurf"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("anmeldung_verfahren_range", sql`${t.closesAt} > ${t.opensAt}`),
    check("anmeldung_verfahren_keep", sql`${t.rejectKeepDays} between 31 and 365`),
  ],
);

/** Gesprächstermine (Slots) eines Verfahrens. */
export const anmeldungSlots = pgTable(
  "anmeldung_slots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    verfahrenId: text("verfahren_id")
      .notNull()
      .references(() => anmeldungVerfahren.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** parallele Gespräche */
    capacity: integer("capacity").notNull().default(1),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("anmeldung_slots_start_uq").on(t.verfahrenId, t.startsAt),
    check("anmeldung_slots_range", sql`${t.endsAt} > ${t.startsAt}`),
    check("anmeldung_slots_capacity", sql`${t.capacity} between 1 and 50`),
  ],
);

/** Antrag (Vormerkung) eines Kindes. Nummer „A-<year>-<seq>“ (year = Beginn des Zielschuljahres). */
export const anmeldungAntraege = pgTable(
  "anmeldung_antraege",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    verfahrenId: text("verfahren_id")
      .notNull()
      .references(() => anmeldungVerfahren.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    seq: integer("seq").notNull(),
    status: anmeldungAntragStatusEnum("status").notNull().default("unbestaetigt"),
    childFirstName: text("child_first_name").notNull(),
    childLastName: text("child_last_name").notNull(),
    childBirthDate: date("child_birth_date").notNull(),
    primarySchool: text("primary_school"),
    sibling: boolean("sibling").notNull().default(false),
    siblingNote: text("sibling_note"),
    secondChoiceSchool: text("second_choice_school"),
    parent1Name: text("parent1_name").notNull(),
    parent1Email: text("parent1_email").notNull(),
    parent1Phone: text("parent1_phone"),
    addressStreet: text("address_street"),
    addressZip: text("address_zip"),
    addressCity: text("address_city"),
    parent2Name: text("parent2_name"),
    /** Q5-23: optional, nur mit Namen; wird nicht per Link bestätigt (Mails gehen nur an Elternteil 1), dient der Übernahme */
    parent2Email: text("parent2_email"),
    /** höchstens 300 Zeichen, Hinweis: keine Gesundheitsdaten */
    hints: text("hints"),
    slotId: text("slot_id").references(() => anmeldungSlots.id, { onDelete: "set null" }),
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    /** Double-Opt-In: nur SHA-256 des Tokens */
    confirmTokenHash: text("confirm_token_hash"),
    confirmExpiresAt: timestamp("confirm_expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Bearbeitungslink für Eltern: nur SHA-256 */
    accessTokenHash: text("access_token_hash"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    /** „vorgelegt“ je Unterlage (Häkchen, keine Uploads – Q-37) */
    checklist: jsonb("checklist").notNull().default({}),
    /** interne Notiz zur Entscheidung (keine Gesundheitsdaten) */
    decisionNote: text("decision_note"),
    /** P4-78: als Spam abgelehnt (Sammel-Ablehnung) – keine Mail, nicht im Serienbrief/Export; echte Entscheidung setzt es zurück */
    rejectedAsSpam: boolean("rejected_as_spam").notNull().default(false),
    /** P4-78b: Spam-Verdacht (Sekretariat markiert, Schulleitung bestätigt oder nimmt zurück) – Stand bleibt, keine Mail */
    spamSuspectedAt: timestamp("spam_suspected_at", { withTimezone: true }),
    spamSuspectedBy: text("spam_suspected_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    transferredUserId: text("transferred_user_id").references(() => users.id, { onDelete: "set null" }),
    transferredAt: timestamp("transferred_at", { withTimezone: true }),
    /** Familien mit Konto (P4-34b, Q-32 Weg 1): Antrag hängt am Elternkonto statt an Bestätigungs- und Vorgangslink */
    parentUserId: text("parent_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Beginn der 90-Tage-Löschfrist (LK-90), gesetzt von der Statusmaschine; offene Anträge: NULL */
    retentionFrom: timestamp("retention_from", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("anmeldung_antraege_number_uq").on(t.year, t.seq),
    uniqueIndex("anmeldung_antraege_confirm_uq").on(t.confirmTokenHash),
    uniqueIndex("anmeldung_antraege_access_uq").on(t.accessTokenHash),
    index("anmeldung_antraege_verfahren_idx").on(t.verfahrenId, t.status),
    index("anmeldung_antraege_slot_idx").on(t.slotId),
    index("anmeldung_antraege_email_idx").on(t.parent1Email),
    index("anmeldung_antraege_parent_idx").on(t.parentUserId),
  ],
);

/** Verlauf eines Antrags (Eingang, Bestätigung, Termin, Status, Notizen, Mails). actor_id NULL = Eltern/System. */
export const anmeldungEreignisse = pgTable(
  "anmeldung_ereignisse",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    antragId: text("antrag_id")
      .notNull()
      .references(() => anmeldungAntraege.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    kind: anmeldungEreignisKindEnum("kind").notNull(),
    text: text("text").notNull().default(""),
  },
  (t) => [index("anmeldung_ereignisse_antrag_idx").on(t.antragId, t.at)],
);
