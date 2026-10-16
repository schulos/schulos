CREATE SEQUENCE "public"."notenbuch_entry_revision" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "notenbuch_offline_devices" DROP CONSTRAINT "notenbuch_offline_devices_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "notenbuch_offline_devices" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "second_factor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notenbuch_offline_devices" ADD COLUMN "reason" text DEFAULT 'zertifikat' NOT NULL;--> statement-breakpoint
ALTER TABLE "notenbuch_offline_devices" ADD CONSTRAINT "notenbuch_offline_devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- G5A-C02: Revisionen ab dem bisherigen Höchststand weiterzählen (bestehende Zellen behalten ihre Revision)
SELECT setval('"public"."notenbuch_entry_revision"', coalesce((SELECT max("version") FROM "notenbuch_entries"), 0) + 1, false);