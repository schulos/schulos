-- SP3-05 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.4, F-10-2): Protokoll der Sofort-Korrekturen am gültigen Plan – je Stunde Art, Stichtag,
-- Vorher/Nachher (Kennungen, keine Namen), Begründung, Handelnde:r und Versand der Änderungsliste an Schüler:innen/Eltern.
CREATE TYPE "public"."plan_change_kind" AS ENUM('split', 'inplace', 'delete', 'create');--> statement-breakpoint
CREATE TABLE "timetable_plan_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text,
	"batch_id" text NOT NULL,
	"kind" "plan_change_kind" NOT NULL,
	"lesson_id" text,
	"successor_id" text,
	"valid_from" date NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notify_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	CONSTRAINT "timetable_plan_changes_reason" CHECK ("timetable_plan_changes"."reason" is null or char_length("timetable_plan_changes"."reason") <= 120)
);
--> statement-breakpoint
ALTER TABLE "timetable_plan_changes" ADD CONSTRAINT "timetable_plan_changes_version_id_timetable_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."timetable_plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_changes" ADD CONSTRAINT "timetable_plan_changes_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_changes" ADD CONSTRAINT "timetable_plan_changes_successor_id_timetable_lessons_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_changes" ADD CONSTRAINT "timetable_plan_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_plan_changes_version_idx" ON "timetable_plan_changes" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "timetable_plan_changes_batch_idx" ON "timetable_plan_changes" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "timetable_plan_changes_notify_idx" ON "timetable_plan_changes" USING btree ("notified_at","notify_at");