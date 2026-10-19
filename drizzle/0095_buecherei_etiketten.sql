ALTER TABLE "buecherei_copies" ADD COLUMN "label_printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "buecherei_copies" ADD COLUMN "loan_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "buecherei_copies" ADD COLUMN "last_loan_month" text;--> statement-breakpoint
-- BU-05: Exemplare mit offener Ausleihe bzw. Befund sind mindestens einmal ausgeliehen worden (Nutzung ohne Person)
UPDATE "buecherei_copies" c SET "loan_count" = 1, "last_loan_month" = to_char(l."loaned_on", 'YYYY-MM') FROM "buecherei_loans" l WHERE l."copy_id" = c."id";
