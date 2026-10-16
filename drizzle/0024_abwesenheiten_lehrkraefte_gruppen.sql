CREATE TYPE "public"."timetable_absence_reason" AS ENUM('krank', 'fortbildung', 'dienstlich', 'klassenfahrt', 'exkursion', 'praktikum', 'pruefung', 'sonstiges');--> statement-breakpoint
CREATE TABLE "timetable_absences" (
	"id" text PRIMARY KEY NOT NULL,
	"teacher_id" text,
	"group_id" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"from_period" integer,
	"to_period" integer,
	"reason" timetable_absence_reason NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_absences_target" CHECK (("timetable_absences"."teacher_id" is null) <> ("timetable_absences"."group_id" is null)),
	CONSTRAINT "timetable_absences_range" CHECK ("timetable_absences"."ends_on" >= "timetable_absences"."starts_on"),
	CONSTRAINT "timetable_absences_periods" CHECK (("timetable_absences"."from_period" is null and "timetable_absences"."to_period" is null) or ("timetable_absences"."from_period" is not null and "timetable_absences"."to_period" is not null and "timetable_absences"."to_period" >= "timetable_absences"."from_period"))
);
--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD CONSTRAINT "timetable_absences_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD CONSTRAINT "timetable_absences_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD CONSTRAINT "timetable_absences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_absences_dates_idx" ON "timetable_absences" USING btree ("starts_on","ends_on");