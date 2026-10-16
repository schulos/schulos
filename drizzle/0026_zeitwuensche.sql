CREATE TYPE "public"."time_pref_kind" AS ENUM('teacher', 'group', 'room', 'subject');--> statement-breakpoint
CREATE TABLE "timetable_time_prefs" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"kind" time_pref_kind NOT NULL,
	"target_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"period_nr" integer NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "timetable_time_prefs_value" CHECK ("timetable_time_prefs"."value" between -3 and 3),
	CONSTRAINT "timetable_time_prefs_weekday" CHECK ("timetable_time_prefs"."weekday" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "timetable_time_prefs" ADD CONSTRAINT "timetable_time_prefs_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_time_prefs_uq" ON "timetable_time_prefs" USING btree ("school_year_id","kind","target_id","weekday","period_nr");