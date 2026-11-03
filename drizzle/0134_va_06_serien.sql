ALTER TYPE "public"."gebaeude_event_history_kind" ADD VALUE 'geaendert';--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltungen" ADD COLUMN "series_id" text;--> statement-breakpoint
CREATE INDEX "gebaeude_veranstaltungen_series_idx" ON "gebaeude_veranstaltungen" USING btree ("series_id");