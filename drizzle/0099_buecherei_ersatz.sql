CREATE TYPE "public"."buecherei_compensation_status" AS ENUM('offen', 'bezahlt', 'erlassen');--> statement-breakpoint
CREATE TABLE "buecherei_compensations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"loan_id" text,
	"issue_id" text,
	"item" text NOT NULL,
	"reason" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "buecherei_compensation_status" DEFAULT 'offen' NOT NULL,
	"created_on" date NOT NULL,
	"closed_on" date,
	"letter_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buecherei_compensations_amount" CHECK ("buecherei_compensations"."amount_cents" between 1 and 99999)
);
--> statement-breakpoint
ALTER TABLE "buecherei_compensations" ADD CONSTRAINT "buecherei_compensations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_compensations" ADD CONSTRAINT "buecherei_compensations_loan_id_buecherei_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."buecherei_loans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_compensations" ADD CONSTRAINT "buecherei_compensations_issue_id_buecherei_material_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."buecherei_material_issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_compensations_loan_idx" ON "buecherei_compensations" USING btree ("loan_id") WHERE "buecherei_compensations"."loan_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_compensations_issue_idx" ON "buecherei_compensations" USING btree ("issue_id") WHERE "buecherei_compensations"."issue_id" is not null;--> statement-breakpoint
CREATE INDEX "buecherei_compensations_user_idx" ON "buecherei_compensations" USING btree ("user_id");