CREATE TABLE "backup_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"snapshot_id" text,
	"bytes_total" bigint,
	"bytes_added" bigint,
	"error" text,
	"agent_version" text
);
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "schedule" jsonb DEFAULT '["01:30"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "run_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_runs_instance_idx" ON "backup_runs" USING btree ("instance_id","finished_at");