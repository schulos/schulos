CREATE TABLE "timetable_assignment_groups" (
	"assignment_id" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "timetable_assignment_groups_assignment_id_group_id_pk" PRIMARY KEY("assignment_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "timetable_assignment_teachers" (
	"assignment_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	CONSTRAINT "timetable_assignment_teachers_assignment_id_teacher_id_pk" PRIMARY KEY("assignment_id","teacher_id")
);
--> statement-breakpoint
CREATE TABLE "timetable_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"hours" integer NOT NULL,
	"double_lessons" integer DEFAULT 0 NOT NULL,
	"room_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_assignments_hours" CHECK ("timetable_assignments"."hours" between 1 and 12),
	CONSTRAINT "timetable_assignments_double" CHECK ("timetable_assignments"."double_lessons" >= 0 and "timetable_assignments"."double_lessons" * 2 <= "timetable_assignments"."hours")
);
--> statement-breakpoint
ALTER TABLE "timetable_assignment_groups" ADD CONSTRAINT "timetable_assignment_groups_assignment_id_timetable_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."timetable_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_assignment_groups" ADD CONSTRAINT "timetable_assignment_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_assignment_teachers" ADD CONSTRAINT "timetable_assignment_teachers_assignment_id_timetable_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."timetable_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_assignment_teachers" ADD CONSTRAINT "timetable_assignment_teachers_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_assignments" ADD CONSTRAINT "timetable_assignments_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_assignments" ADD CONSTRAINT "timetable_assignments_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_assignments" ADD CONSTRAINT "timetable_assignments_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "timetable_assignment_groups_group_idx" ON "timetable_assignment_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "timetable_assignment_teachers_teacher_idx" ON "timetable_assignment_teachers" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "timetable_assignments_year_idx" ON "timetable_assignments" USING btree ("school_year_id");