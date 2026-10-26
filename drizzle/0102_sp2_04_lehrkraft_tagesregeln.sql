CREATE TABLE "timetable_teacher_day_rules" (
	"school_year_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"max_per_day" integer,
	"max_days" integer,
	CONSTRAINT "timetable_teacher_day_rules_school_year_id_teacher_id_pk" PRIMARY KEY("school_year_id","teacher_id"),
	CONSTRAINT "timetable_teacher_day_rules_max" CHECK ("timetable_teacher_day_rules"."max_per_day" is null or "timetable_teacher_day_rules"."max_per_day" between 1 and 20),
	CONSTRAINT "timetable_teacher_day_rules_days" CHECK ("timetable_teacher_day_rules"."max_days" is null or "timetable_teacher_day_rules"."max_days" between 1 and 7)
);
--> statement-breakpoint
ALTER TABLE "timetable_teacher_day_rules" ADD CONSTRAINT "timetable_teacher_day_rules_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_teacher_day_rules" ADD CONSTRAINT "timetable_teacher_day_rules_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;