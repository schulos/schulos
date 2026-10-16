CREATE TYPE "public"."monitor_profile" AS ENUM('foyer', 'lehrerzimmer');--> statement-breakpoint
CREATE TABLE "monitor_screens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"profile" "monitor_profile" DEFAULT 'foyer' NOT NULL,
	"token_hash" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_screens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "news_posts" ADD COLUMN "on_monitor" boolean DEFAULT false NOT NULL;