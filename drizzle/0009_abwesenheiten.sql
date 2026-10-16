CREATE TYPE "public"."absence_reason" AS ENUM('krank', 'sonstiges');--> statement-breakpoint
CREATE TYPE "public"."absence_report_status" AS ENUM('gemeldet', 'entschuldigt', 'nicht_entschuldigt');--> statement-breakpoint
CREATE TABLE "absence_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"student_id" text NOT NULL,
	"reported_by" text,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"reason" "absence_reason" NOT NULL,
	"status" "absence_report_status" DEFAULT 'gemeldet' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "absence_reports_range" CHECK ("absence_reports"."to_date" >= "absence_reports"."from_date")
);
--> statement-breakpoint
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absence_reports_student_idx" ON "absence_reports" USING btree ("student_id","from_date");