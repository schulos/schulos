CREATE TABLE "kurse_links" (
	"group_id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"label" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kurse_links" ADD CONSTRAINT "kurse_links_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurse_links" ADD CONSTRAINT "kurse_links_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;