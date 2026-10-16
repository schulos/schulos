// Klausurplan – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, rooms, subjects } from "../../core/db/schema-core";

export const EXAM_KINDS = ["klassenarbeit", "klausur", "test"] as const;
export const examKindEnum = pgEnum("exam_kind", EXAM_KINDS);

export const exams = pgTable(
  "exams",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => subjects.id, { onUpdate: "cascade" }),
    kind: examKindEnum("kind").notNull(),
    /** z. B. „2. Klassenarbeit“ */
    title: text("title").notNull(),
    date: date("date").notNull(),
    periodFrom: integer("period_from").notNull(),
    periodTo: integer("period_to").notNull(),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    teacherId: text("teacher_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("exams_periods", sql`${t.periodTo} >= ${t.periodFrom}`), index("exams_group_date_idx").on(t.groupId, t.date), index("exams_date_idx").on(t.date)],
);

export type Exam = typeof exams.$inferSelect;
