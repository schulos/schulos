ALTER TABLE "buecherei_loans" ADD COLUMN "reminded_due_on" date;--> statement-breakpoint
ALTER TABLE "buecherei_loans" ADD COLUMN "dunning_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "buecherei_loans" ADD COLUMN "dunned_on" date;--> statement-breakpoint
ALTER TABLE "buecherei_stats" ADD COLUMN "dunnings" integer DEFAULT 0 NOT NULL;