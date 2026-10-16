CREATE TABLE "notenbuch_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notenbuch_sessions" ADD CONSTRAINT "notenbuch_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_sessions" ADD CONSTRAINT "notenbuch_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;