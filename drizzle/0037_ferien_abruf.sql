ALTER TABLE "school_closures" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "school_closures" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "school_closures_external_idx" ON "school_closures" USING btree ("external_id");