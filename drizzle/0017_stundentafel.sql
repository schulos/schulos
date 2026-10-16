CREATE TABLE "curriculum_hours" (
	"grade_level" integer NOT NULL,
	"subject_id" text NOT NULL,
	"hours" integer NOT NULL,
	CONSTRAINT "curriculum_hours_grade_level_subject_id_pk" PRIMARY KEY("grade_level","subject_id"),
	CONSTRAINT "curriculum_hours_range" CHECK ("curriculum_hours"."hours" between 1 and 12)
);
--> statement-breakpoint
ALTER TABLE "curriculum_hours" ADD CONSTRAINT "curriculum_hours_grade_level_grade_levels_level_fk" FOREIGN KEY ("grade_level") REFERENCES "public"."grade_levels"("level") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_hours" ADD CONSTRAINT "curriculum_hours_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE cascade;