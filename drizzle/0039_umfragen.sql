CREATE TYPE "public"."umfragen_question_kind" AS ENUM('single', 'multi', 'scale', 'text');--> statement-breakpoint
CREATE TABLE "umfragen_answers" (
	"response_id" text NOT NULL,
	"question_id" text NOT NULL,
	"respondent_id" text,
	"choices" jsonb,
	"scale" integer,
	"text" text,
	CONSTRAINT "umfragen_answers_response_id_question_id_pk" PRIMARY KEY("response_id","question_id"),
	CONSTRAINT "umfragen_answers_scale" CHECK ("umfragen_answers"."scale" is null or "umfragen_answers"."scale" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "umfragen_participation" (
	"survey_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "umfragen_participation_survey_id_user_id_pk" PRIMARY KEY("survey_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "umfragen_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" "umfragen_question_kind" NOT NULL,
	"text" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "umfragen_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"respondent_id" text,
	"day" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "umfragen_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"survey_id" text NOT NULL,
	"role" "role",
	"group_id" text,
	"parents" boolean DEFAULT false NOT NULL,
	CONSTRAINT "umfragen_targets_one" CHECK (("umfragen_targets"."role" is null) <> ("umfragen_targets"."group_id" is null) and (not "umfragen_targets"."parents" or "umfragen_targets"."group_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "umfragen_surveys" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "umfragen_surveys_period" CHECK ("umfragen_surveys"."closes_at" > "umfragen_surveys"."opens_at")
);
--> statement-breakpoint
ALTER TABLE "umfragen_answers" ADD CONSTRAINT "umfragen_answers_response_id_umfragen_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."umfragen_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_answers" ADD CONSTRAINT "umfragen_answers_question_id_umfragen_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."umfragen_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_answers" ADD CONSTRAINT "umfragen_answers_respondent_id_users_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_participation" ADD CONSTRAINT "umfragen_participation_survey_id_umfragen_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."umfragen_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_participation" ADD CONSTRAINT "umfragen_participation_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_questions" ADD CONSTRAINT "umfragen_questions_survey_id_umfragen_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."umfragen_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_responses" ADD CONSTRAINT "umfragen_responses_survey_id_umfragen_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."umfragen_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_responses" ADD CONSTRAINT "umfragen_responses_respondent_id_users_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_targets" ADD CONSTRAINT "umfragen_targets_survey_id_umfragen_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."umfragen_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_targets" ADD CONSTRAINT "umfragen_targets_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "umfragen_surveys" ADD CONSTRAINT "umfragen_surveys_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "umfragen_questions_pos_uq" ON "umfragen_questions" USING btree ("survey_id","position");--> statement-breakpoint
CREATE INDEX "umfragen_responses_survey_idx" ON "umfragen_responses" USING btree ("survey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "umfragen_targets_role_uq" ON "umfragen_targets" USING btree ("survey_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "umfragen_targets_group_uq" ON "umfragen_targets" USING btree ("survey_id","group_id","parents");--> statement-breakpoint
CREATE INDEX "umfragen_surveys_closes_idx" ON "umfragen_surveys" USING btree ("closes_at");