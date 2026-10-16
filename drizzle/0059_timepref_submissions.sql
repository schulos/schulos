CREATE TABLE "timetable_time_pref_submissions" (
	"school_year_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_time_pref_submissions_school_year_id_teacher_id_pk" PRIMARY KEY("school_year_id","teacher_id")
);
--> statement-breakpoint
ALTER TABLE "timetable_time_pref_submissions" ADD CONSTRAINT "timetable_time_pref_submissions_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_time_pref_submissions" ADD CONSTRAINT "timetable_time_pref_submissions_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;