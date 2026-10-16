CREATE TABLE "notenbuch_offline_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"server_share" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notenbuch_offline_devices" ADD CONSTRAINT "notenbuch_offline_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_offline_devices" ADD CONSTRAINT "notenbuch_offline_devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notenbuch_offline_devices_user_idx" ON "notenbuch_offline_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notenbuch_offline_devices_session_idx" ON "notenbuch_offline_devices" USING btree ("session_id");