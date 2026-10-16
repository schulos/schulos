// Klassenbuch – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, subjects } from "../../core/db/schema-core";
import { timetableLessons } from "../stundenplan/schema";

/**
 * Eintrag je gehaltener Stunde. Gruppe, Stunde und Fach werden mitgespeichert, damit das
 * Klassenbuch als Akte stabil bleibt, auch wenn sich der Stundenplan später ändert.
 */
export const classbookEntries = pgTable(
  "classbook_entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    lessonId: text("lesson_id").references(() => timetableLessons.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    periodNr: integer("period_nr").notNull(),
    subjectId: text("subject_id")
      .notNull()
      .references(() => subjects.id, { onUpdate: "cascade" }),
    /** wer die Stunde gehalten und eingetragen hat */
    teacherId: text("teacher_id").references(() => users.id, { onDelete: "set null" }),
    topic: text("topic").notNull(),
    homework: text("homework"),
    /** Q5-27: „fällig am“, von der Lehrkraft gesetzt; null = zur nächsten Stunde derselben Gruppe im Fach */
    homeworkDue: date("homework_due"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("classbook_entries_lesson_date_uq").on(t.lessonId, t.date),
    index("classbook_entries_group_date_idx").on(t.groupId, t.date),
  ],
);

/** absent = fehlt · late = verspätet. Bewusst ohne Grund (Art. 9 DSGVO); entschuldigt wird über P2-09. */
export const ABSENCE_KINDS = ["absent", "late"] as const;
export const absenceKindEnum = pgEnum("classbook_absence_kind", ABSENCE_KINDS);

export const classbookAbsences = pgTable(
  "classbook_absences",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    entryId: text("entry_id")
      .notNull()
      .references(() => classbookEntries.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: absenceKindEnum("kind").notNull(),
    minutesLate: integer("minutes_late"),
    /** null = offen, true = entschuldigt, false = unentschuldigt */
    excused: boolean("excused"),
  },
  (t) => [
    uniqueIndex("classbook_absences_entry_student_uq").on(t.entryId, t.studentId),
    index("classbook_absences_student_idx").on(t.studentId),
    check("classbook_absences_late", sql`(${t.kind} = 'late') = (${t.minutesLate} is not null)`),
  ],
);

export type ClassbookEntry = typeof classbookEntries.$inferSelect;
export type ClassbookAbsence = typeof classbookAbsences.$inferSelect;
