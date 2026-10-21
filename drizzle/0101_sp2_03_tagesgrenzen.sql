CREATE TABLE "timetable_grade_rules" (
	"grade_level" integer PRIMARY KEY NOT NULL,
	"max_per_day" integer,
	"afternoons_per_week" integer,
	"lunch_after_period" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_grade_rules_max" CHECK ("timetable_grade_rules"."max_per_day" is null or "timetable_grade_rules"."max_per_day" between 1 and 20),
	CONSTRAINT "timetable_grade_rules_pm" CHECK ("timetable_grade_rules"."afternoons_per_week" is null or "timetable_grade_rules"."afternoons_per_week" between 0 and 7),
	CONSTRAINT "timetable_grade_rules_lunch" CHECK ("timetable_grade_rules"."lunch_after_period" is null or "timetable_grade_rules"."lunch_after_period" between 1 and 20)
);
