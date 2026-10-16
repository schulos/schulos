ALTER TABLE "absence_reports" ADD COLUMN "archive_id" text;--> statement-breakpoint
ALTER TABLE "absence_reports" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_archive_id_record_archives_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."record_archives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absence_reports_archive_idx" ON "absence_reports" USING btree ("archive_id");