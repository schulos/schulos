ALTER TABLE "notifications" ADD COLUMN "bundle_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_bundle_uq" ON "notifications" USING btree ("user_id","bundle_key");