CREATE TABLE "timetable_duties" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"area_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"after_period" integer NOT NULL,
	"teacher_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_duties_weekday" CHECK ("timetable_duties"."weekday" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "timetable_duty_areas" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "timetable_duty_areas_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "timetable_duty_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"duty_id" text NOT NULL,
	"date" date NOT NULL,
	"substitute_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timetable_duties" ADD CONSTRAINT "timetable_duties_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_duties" ADD CONSTRAINT "timetable_duties_area_id_timetable_duty_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."timetable_duty_areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_duties" ADD CONSTRAINT "timetable_duties_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_duty_changes" ADD CONSTRAINT "timetable_duty_changes_duty_id_timetable_duties_id_fk" FOREIGN KEY ("duty_id") REFERENCES "public"."timetable_duties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_duty_changes" ADD CONSTRAINT "timetable_duty_changes_substitute_id_users_id_fk" FOREIGN KEY ("substitute_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_duty_changes" ADD CONSTRAINT "timetable_duty_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_duties_uq" ON "timetable_duties" USING btree ("school_year_id","area_id","weekday","after_period","teacher_id");--> statement-breakpoint
CREATE INDEX "timetable_duties_teacher_idx" ON "timetable_duties" USING btree ("teacher_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_duty_changes_uq" ON "timetable_duty_changes" USING btree ("duty_id","date");