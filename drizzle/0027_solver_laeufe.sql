CREATE TYPE "public"."solver_run_status" AS ENUM('running', 'done', 'failed', 'applied');--> statement-breakpoint
CREATE TABLE "timetable_solver_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"status" "solver_run_status" DEFAULT 'running' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"seed" integer DEFAULT 1 NOT NULL,
	"iterations" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"applied_from" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD COLUMN "fixed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD CONSTRAINT "timetable_solver_runs_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD CONSTRAINT "timetable_solver_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;