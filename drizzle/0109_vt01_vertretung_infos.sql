CREATE TYPE "public"."day_note_audience" AS ENUM('alle', 'beschaeftigte');--> statement-breakpoint
CREATE TYPE "public"."substitution_change_action" AS ENUM('create', 'update', 'delete', 'plan_publish', 'plan_undo');--> statement-breakpoint
CREATE TYPE "public"."substitution_reason" AS ENUM('lehrkraft_abwesend', 'klassenfahrt', 'exkursion', 'praktikum', 'pruefung', 'veranstaltung', 'raum_gesperrt', 'organisatorisch', 'sonstiges');--> statement-breakpoint
CREATE TABLE "timetable_day_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"body" text NOT NULL,
	"audience" "day_note_audience" DEFAULT 'alle' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_day_notes_body" CHECK (char_length("timetable_day_notes"."body") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "timetable_substitution_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text,
	"date" date NOT NULL,
	"substitution_id" text,
	"action" "substitution_change_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "timetable_absence_materials_uq";--> statement-breakpoint
ALTER TABLE "timetable_absence_materials" ALTER COLUMN "absence_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "reason" "substitution_reason";--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "internal_note" text;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "supervision_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_day_notes" ADD CONSTRAINT "timetable_day_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_substitution_changes" ADD CONSTRAINT "timetable_substitution_changes_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_substitution_changes" ADD CONSTRAINT "timetable_substitution_changes_substitution_id_timetable_substitutions_id_fk" FOREIGN KEY ("substitution_id") REFERENCES "public"."timetable_substitutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_substitution_changes" ADD CONSTRAINT "timetable_substitution_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_day_notes_date_idx" ON "timetable_day_notes" USING btree ("date");--> statement-breakpoint
CREATE INDEX "timetable_substitution_changes_date_idx" ON "timetable_substitution_changes" USING btree ("date","created_at");--> statement-breakpoint
CREATE INDEX "timetable_substitution_changes_lesson_idx" ON "timetable_substitution_changes" USING btree ("lesson_id","date");--> statement-breakpoint
CREATE INDEX "timetable_substitution_changes_substitution_idx" ON "timetable_substitution_changes" USING btree ("substitution_id");--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_absence_materials_uq" ON "timetable_absence_materials" USING btree ("lesson_id","date",coalesce("absence_id", ''));--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_supervision" CHECK (not "timetable_substitutions"."supervision_only" or "timetable_substitutions"."kind" = 'substitute');--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_internal_note" CHECK ("timetable_substitutions"."internal_note" is null or char_length("timetable_substitutions"."internal_note") <= 300);