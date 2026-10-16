// Elternbriefe – nur relative Imports (drizzle-kit).
import { bigint, boolean, date, index, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const LETTER_RESPONSES = ["none", "yesno", "text"] as const;
export const letterResponseEnum = pgEnum("letter_response", LETTER_RESPONSES);

export const parentLetters = pgTable("parent_letters", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  /** Markdown */
  body: text("body").notNull(),
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  responseType: letterResponseEnum("response_type").notNull().default("none"),
  /** Frage zur Rückmeldung, z. B. „Darf Ihr Kind am Ausflug teilnehmen?“ */
  question: text("question"),
  /** Rückmeldung bis (einschließlich) */
  dueDate: date("due_date"),
  attachmentName: text("attachment_name"),
  attachmentMime: text("attachment_mime"),
  attachmentSize: bigint("attachment_size", { mode: "number" }),
  attachmentKey: text("attachment_key"),
  lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const parentLetterGroups = pgTable(
  "parent_letter_groups",
  {
    letterId: text("letter_id")
      .notNull()
      .references(() => parentLetters.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.letterId, t.groupId] })],
);

/** Je Schüler:in eine Rückmeldung – bestätigen kann jedes Elternteil. Empfänger werden beim Versand festgeschrieben. */
export const parentLetterReceipts = pgTable(
  "parent_letter_receipts",
  {
    letterId: text("letter_id")
      .notNull()
      .references(() => parentLetters.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    answerYes: boolean("answer_yes"),
    answerText: text("answer_text"),
  },
  (t) => [primaryKey({ columns: [t.letterId, t.studentId] }), index("parent_letter_receipts_student_idx").on(t.studentId)],
);

export type ParentLetter = typeof parentLetters.$inferSelect;
