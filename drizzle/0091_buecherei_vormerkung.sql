CREATE TABLE "buecherei_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"title_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ready_on" date,
	"hold_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buecherei_reservations" ADD CONSTRAINT "buecherei_reservations_title_id_buecherei_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."buecherei_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_reservations" ADD CONSTRAINT "buecherei_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_reservations_title_user_idx" ON "buecherei_reservations" USING btree ("title_id","user_id");--> statement-breakpoint
CREATE INDEX "buecherei_reservations_user_idx" ON "buecherei_reservations" USING btree ("user_id");