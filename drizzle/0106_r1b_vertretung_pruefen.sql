ALTER TABLE "timetable_substitutions" DROP CONSTRAINT "timetable_substitutions_merge_lesson_id_timetable_lessons_id_fk";
--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "absence_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_merge_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("merge_lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE set null ON UPDATE no action;