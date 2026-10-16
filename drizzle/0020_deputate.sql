CREATE TYPE "public"."reduction_reason" AS ENUM('alter', 'schulleitung', 'koordination', 'klassenleitung', 'fachleitung', 'ausbildung', 'personalrat', 'sonstige_aufgabe', 'sonstige_ermaessigung');--> statement-breakpoint
CREATE TABLE "timetable_deputies" (
	"school_year_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"obligation" numeric(4, 1) NOT NULL,
	CONSTRAINT "timetable_deputies_school_year_id_teacher_id_pk" PRIMARY KEY("school_year_id","teacher_id"),
	CONSTRAINT "timetable_deputies_range" CHECK ("timetable_deputies"."obligation" between 0 and 40)
);
--> statement-breakpoint
CREATE TABLE "timetable_reductions" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"reason" "reduction_reason" NOT NULL,
	"hours" numeric(4, 1) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_reductions_hours" CHECK ("timetable_reductions"."hours" > 0 and "timetable_reductions"."hours" <= 30)
);
--> statement-breakpoint
ALTER TABLE "timetable_deputies" ADD CONSTRAINT "timetable_deputies_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_deputies" ADD CONSTRAINT "timetable_deputies_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_reductions" ADD CONSTRAINT "timetable_reductions_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_reductions" ADD CONSTRAINT "timetable_reductions_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_reductions_teacher_idx" ON "timetable_reductions" USING btree ("school_year_id","teacher_id");