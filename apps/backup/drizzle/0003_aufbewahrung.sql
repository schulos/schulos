CREATE TABLE "maintenance_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"details" jsonb,
	"error" text,
	"triggered_by" text
);
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "retention" jsonb DEFAULT '{"daily":14,"weekly":4,"monthly":3}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "retention_reason" text;--> statement-breakpoint
ALTER TABLE "maintenance_runs" ADD CONSTRAINT "maintenance_runs_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_runs" ADD CONSTRAINT "maintenance_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_runs_instance_idx" ON "maintenance_runs" USING btree ("instance_id","kind","finished_at");