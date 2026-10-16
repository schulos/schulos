ALTER TYPE "public"."role" ADD VALUE 'beratung' BEFORE 'verwaltung';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "office_hours" text;