// Umfragen (P3-03) – nur relative Imports (drizzle-kit).
// Anonym heißt technisch: Antworten (umfragen_responses/answers) tragen keinen Benutzerbezug und nur den Tag,
// wer teilgenommen hat, steht getrennt und ohne Zeitpunkt in umfragen_participation (gegen doppelte Teilnahme).
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { roleEnum, users } from "../../core/db/schema-auth";
import { groups } from "../../core/db/schema-core";

export const QUESTION_KINDS = ["single", "multi", "scale", "text"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const questionKindEnum = pgEnum("umfragen_question_kind", QUESTION_KINDS);

export const surveys = pgTable(
  "umfragen_surveys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** Markdown */
    description: text("description").notNull().default(""),
    anonymous: boolean("anonymous").notNull().default(true),
    /** Schnellumfrage (P3-05): eine Frage, immer anonym, an eine Gruppe, live im Kursraum/Gruppenchat */
    quick: boolean("quick").notNull().default(false),
    opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("umfragen_surveys_period", sql`${t.closesAt} > ${t.opensAt}`), index("umfragen_surveys_closes_idx").on(t.closesAt)],
);

/** Zielgruppen: eine Rolle, die Mitglieder einer Gruppe oder (parents) die Eltern der Schüler:innen einer Gruppe. */
export const surveyTargets = pgTable(
  "umfragen_targets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    role: roleEnum("role"),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    parents: boolean("parents").notNull().default(false),
  },
  (t) => [
    check("umfragen_targets_one", sql`(${t.role} is null) <> (${t.groupId} is null) and (not ${t.parents} or ${t.groupId} is not null)`),
    uniqueIndex("umfragen_targets_role_uq").on(t.surveyId, t.role),
    uniqueIndex("umfragen_targets_group_uq").on(t.surveyId, t.groupId, t.parents),
  ],
);

export const surveyQuestions = pgTable(
  "umfragen_questions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: questionKindEnum("kind").notNull(),
    text: text("text").notNull(),
    /** Antwortmöglichkeiten bei Einfach-/Mehrfachauswahl */
    options: jsonb("options").$type<string[]>().notNull().default([]),
    required: boolean("required").notNull().default(true),
  },
  (t) => [uniqueIndex("umfragen_questions_pos_uq").on(t.surveyId, t.position)],
);

/** Eine ausgefüllte Umfrage. Bei anonymen Umfragen ohne respondent_id; nie genauer als der Tag. */
export const surveyResponses = pgTable(
  "umfragen_responses",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    respondentId: text("respondent_id").references(() => users.id, { onDelete: "set null" }),
    day: date("day").notNull(),
    /** Eingangsreihenfolge (ohne Uhrzeit) – anonyme Ergebnisse zählen nur die ersten ⌊n/5⌋·5 Antworten (Fünferschritte) */
    seq: integer("seq").generatedAlwaysAsIdentity().notNull(),
  },
  (t) => [index("umfragen_responses_survey_idx").on(t.surveyId)],
);

export const surveyAnswers = pgTable(
  "umfragen_answers",
  {
    responseId: text("response_id")
      .notNull()
      .references(() => surveyResponses.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => surveyQuestions.id, { onDelete: "cascade" }),
    /** wie umfragen_responses.respondent_id (bei anonymen Umfragen leer) – damit die Auskunft (Art. 15) die Antworten findet */
    respondentId: text("respondent_id").references(() => users.id, { onDelete: "set null" }),
    /** gewählte Optionen (Index in options) bei Einfach-/Mehrfachauswahl */
    choices: jsonb("choices").$type<number[]>(),
    /** 1–5 bei Skala */
    scale: integer("scale"),
    text: text("text"),
  },
  (t) => [primaryKey({ columns: [t.responseId, t.questionId] }), check("umfragen_answers_scale", sql`${t.scale} is null or ${t.scale} between 1 and 5`)],
);

/** Wer teilgenommen hat – ohne Zeitpunkt und ohne Verweis auf die Antwort. */
export const surveyParticipation = pgTable(
  "umfragen_participation",
  {
    surveyId: text("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.surveyId, t.userId] })],
);
