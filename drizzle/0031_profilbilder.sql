CREATE TYPE "public"."photo_consent_basis" AS ENUM('self', 'parent', 'paper');--> statement-breakpoint
CREATE TABLE "profile_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"consent_basis" "photo_consent_basis" NOT NULL,
	"consent_by" text,
	"consent_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_photos_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_consent_by_users_id_fk" FOREIGN KEY ("consent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;