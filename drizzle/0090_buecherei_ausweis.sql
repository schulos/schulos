CREATE TABLE "buecherei_cards" (
	"user_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buecherei_cards_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "buecherei_cards" ADD CONSTRAINT "buecherei_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;