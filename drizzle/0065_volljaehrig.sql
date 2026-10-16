ALTER TABLE "users" ADD COLUMN "self_responsible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "parents_informed_since" timestamp with time zone;