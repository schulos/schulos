ALTER TABLE "timetable_lessons" ADD COLUMN "coupling_id" text;--> statement-breakpoint
CREATE INDEX "timetable_lessons_coupling_idx" ON "timetable_lessons" USING btree ("coupling_id");