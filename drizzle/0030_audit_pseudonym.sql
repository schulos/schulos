ALTER TABLE "audit_log" ADD COLUMN "actor_pseudonym" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "pseudonymized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_log_actor_action_idx" ON "audit_log" USING btree ("actor_id","action");