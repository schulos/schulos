CREATE TABLE "notenbuch_notice_acks" (
	"user_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notenbuch_notice_acks" ADD CONSTRAINT "notenbuch_notice_acks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;