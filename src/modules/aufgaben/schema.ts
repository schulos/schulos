// Aufgaben – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { bigint, check, index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const SUBMISSION_TYPES = ["file", "text", "confirm"] as const;
export const submissionTypeEnum = pgEnum("submission_type", SUBMISSION_TYPES);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    /** Markdown */
    description: text("description").notNull().default(""),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    submissionType: submissionTypeEnum("submission_type").notNull().default("file"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("tasks_due_after_start", sql`${t.dueAt} > ${t.startsAt}`), index("tasks_due_idx").on(t.dueAt)],
);

export const taskGroups = pgTable(
  "task_groups",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.groupId] }), index("task_groups_group_idx").on(t.groupId)],
);

export const taskSubmissions = pgTable(
  "task_submissions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    feedback: text("feedback"),
    grade: text("grade"),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("task_submissions_once").on(t.taskId, t.studentId)],
);

/** Anhänge: zur Aufgabe (submissionId leer) oder zu einer Abgabe. */
export const taskFiles = pgTable(
  "task_files",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    submissionId: text("submission_id").references(() => taskSubmissions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("task_files_task_idx").on(t.taskId), index("task_files_submission_idx").on(t.submissionId)],
);
