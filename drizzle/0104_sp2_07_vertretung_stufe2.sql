ALTER TYPE "public"."substitution_kind" ADD VALUE 'move';--> statement-breakpoint
ALTER TYPE "public"."substitution_kind" ADD VALUE 'merge';--> statement-breakpoint
CREATE TABLE "timetable_standby" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"period_nr" integer NOT NULL,
	"teacher_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_standby_weekday" CHECK ("timetable_standby"."weekday" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "target_period" integer;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD COLUMN "merge_lesson_id" text;--> statement-breakpoint
ALTER TABLE "timetable_standby" ADD CONSTRAINT "timetable_standby_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_standby" ADD CONSTRAINT "timetable_standby_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_standby" ADD CONSTRAINT "timetable_standby_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_standby_uq" ON "timetable_standby" USING btree ("school_year_id","weekday","period_nr","teacher_id");--> statement-breakpoint
CREATE INDEX "timetable_standby_teacher_idx" ON "timetable_standby" USING btree ("teacher_id");--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_merge_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("merge_lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_substitutions_merge_idx" ON "timetable_substitutions" USING btree ("merge_lesson_id");