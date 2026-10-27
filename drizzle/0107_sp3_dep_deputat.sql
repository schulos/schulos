ALTER TABLE "timetable_deputies" ALTER COLUMN "obligation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_deputies" ADD COLUMN "employment_percent" numeric(5, 1);--> statement-breakpoint
ALTER TABLE "timetable_deputies" ADD COLUMN "obligation_term2" numeric(4, 1);--> statement-breakpoint
ALTER TABLE "timetable_reductions" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "timetable_reductions" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "timetable_deputies" ADD CONSTRAINT "timetable_deputies_percent" CHECK ("timetable_deputies"."employment_percent" > 0 and "timetable_deputies"."employment_percent" <= 100);--> statement-breakpoint
ALTER TABLE "timetable_deputies" ADD CONSTRAINT "timetable_deputies_term2" CHECK ("timetable_deputies"."obligation_term2" between 0 and 40);--> statement-breakpoint
ALTER TABLE "timetable_reductions" ADD CONSTRAINT "timetable_reductions_validity" CHECK ("timetable_reductions"."valid_from" is null or "timetable_reductions"."valid_until" is null or "timetable_reductions"."valid_from" <= "timetable_reductions"."valid_until");