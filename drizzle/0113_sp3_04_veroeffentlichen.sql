-- SP3-04 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.3, F-10-4): Änderungsliste an Schüler:innen/Eltern beim Veröffentlichen einer Planversion –
-- Zeilen je Klasse/Kurs (ohne Namen, Lehrkräfte als Kürzel), geplanter und tatsächlicher Versand. Nach dem Versand geleert.
ALTER TABLE "timetable_plan_versions" ADD COLUMN "notify" jsonb;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD COLUMN "notify_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD COLUMN "notified_at" timestamp with time zone;
