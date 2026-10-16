CREATE TYPE "public"."room_kind" AS ENUM('klassenraum', 'nw', 'informatik', 'kunst', 'musik', 'sport', 'werkraum', 'kueche', 'mensa', 'aula', 'sonstiges');--> statement-breakpoint
ALTER TABLE "groups" DROP CONSTRAINT "groups_subject_id_subjects_id_fk";
--> statement-breakpoint
ALTER TABLE "timetable_lessons" DROP CONSTRAINT "timetable_lessons_subject_id_subjects_id_fk";
--> statement-breakpoint
ALTER TABLE "classbook_entries" DROP CONSTRAINT "classbook_entries_subject_id_subjects_id_fk";
--> statement-breakpoint
ALTER TABLE "exams" DROP CONSTRAINT "exams_subject_id_subjects_id_fk";
--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "room_kind" "room_kind";--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "classbook_entries" ADD CONSTRAINT "classbook_entries_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE cascade;