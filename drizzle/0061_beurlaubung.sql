CREATE TYPE "public"."absence_leave_decider" AS ENUM('klassenleitung', 'schulleitung');--> statement-breakpoint
CREATE TYPE "public"."absence_leave_reason" AS ENUM('familiaer', 'veranstaltung', 'sonstiges');--> statement-breakpoint
CREATE TYPE "public"."absence_leave_status" AS ENUM('beantragt', 'genehmigt', 'abgelehnt');--> statement-breakpoint
CREATE TABLE "absence_leave_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"student_id" text NOT NULL,
	"requested_by" text,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"school_days" integer NOT NULL,
	"reason" "absence_leave_reason" NOT NULL,
	"decider" "absence_leave_decider" NOT NULL,
	"status" "absence_leave_status" DEFAULT 'beantragt' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "absence_leave_requests_range" CHECK ("absence_leave_requests"."to_date" >= "absence_leave_requests"."from_date")
);
--> statement-breakpoint
ALTER TABLE "absence_leave_requests" ADD CONSTRAINT "absence_leave_requests_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_leave_requests" ADD CONSTRAINT "absence_leave_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_leave_requests" ADD CONSTRAINT "absence_leave_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absence_leave_requests_student_idx" ON "absence_leave_requests" USING btree ("student_id","from_date");