ALTER TYPE "public"."solver_run_status" ADD VALUE 'queued';--> statement-breakpoint
ALTER TYPE "public"."solver_run_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD COLUMN "solver_run_id" text;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "params" jsonb;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "log" jsonb;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "applied_by" text;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD COLUMN "undo" jsonb;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_solver_run_id_timetable_solver_runs_id_fk" FOREIGN KEY ("solver_run_id") REFERENCES "public"."timetable_solver_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_solver_runs" ADD CONSTRAINT "timetable_solver_runs_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_lessons_solver_run_idx" ON "timetable_lessons" USING btree ("solver_run_id");