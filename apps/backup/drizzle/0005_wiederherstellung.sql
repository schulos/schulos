CREATE TABLE "restore_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"snapshot_short" text NOT NULL,
	"snapshot_time" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"code_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"details" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restore_jobs_instance_idx" ON "restore_jobs" USING btree ("instance_id","created_at");