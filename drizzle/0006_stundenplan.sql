CREATE TYPE "public"."lesson_week" AS ENUM('all', 'A', 'B');--> statement-breakpoint
CREATE TABLE "timetable_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"period_nr" integer NOT NULL,
	"subject_id" text NOT NULL,
	"teacher_id" text,
	"room_id" text,
	"week" "lesson_week" DEFAULT 'all' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_lessons_weekday" CHECK ("timetable_lessons"."weekday" between 0 and 4),
	CONSTRAINT "timetable_lessons_valid" CHECK ("timetable_lessons"."valid_until" is null or "timetable_lessons"."valid_until" >= "timetable_lessons"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_period_nr_periods_nr_fk" FOREIGN KEY ("period_nr") REFERENCES "public"."periods"("nr") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_lessons_group_idx" ON "timetable_lessons" USING btree ("group_id","weekday");--> statement-breakpoint
CREATE INDEX "timetable_lessons_teacher_idx" ON "timetable_lessons" USING btree ("teacher_id","weekday");--> statement-breakpoint
CREATE INDEX "timetable_lessons_room_idx" ON "timetable_lessons" USING btree ("room_id","weekday");