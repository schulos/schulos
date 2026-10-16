CREATE TYPE "public"."classbook_absence_kind" AS ENUM('absent', 'late');--> statement-breakpoint
CREATE TABLE "classbook_absences" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"student_id" text NOT NULL,
	"kind" "classbook_absence_kind" NOT NULL,
	"minutes_late" integer,
	"excused" boolean,
	CONSTRAINT "classbook_absences_late" CHECK (("classbook_absences"."kind" = 'late') = ("classbook_absences"."minutes_late" is not null))
);
--> statement-breakpoint
CREATE TABLE "classbook_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text,
	"date" date NOT NULL,
	"group_id" text NOT NULL,
	"period_nr" integer NOT NULL,
	"subject_id" text NOT NULL,
	"teacher_id" text,
	"topic" text NOT NULL,
	"homework" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classbook_absences" ADD CONSTRAINT "classbook_absences_entry_id_classbook_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."classbook_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classbook_absences" ADD CONSTRAINT "classbook_absences_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classbook_entries" ADD CONSTRAINT "classbook_entries_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classbook_entries" ADD CONSTRAINT "classbook_entries_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classbook_entries" ADD CONSTRAINT "classbook_entries_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classbook_entries" ADD CONSTRAINT "classbook_entries_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "classbook_absences_entry_student_uq" ON "classbook_absences" USING btree ("entry_id","student_id");--> statement-breakpoint
CREATE INDEX "classbook_absences_student_idx" ON "classbook_absences" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classbook_entries_lesson_date_uq" ON "classbook_entries" USING btree ("lesson_id","date");--> statement-breakpoint
CREATE INDEX "classbook_entries_group_date_idx" ON "classbook_entries" USING btree ("group_id","date");