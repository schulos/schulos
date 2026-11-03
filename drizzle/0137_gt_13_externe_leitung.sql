CREATE TABLE "ganztag_external_leaders" (
	"user_id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"provider" text NOT NULL,
	"confidentiality_at" timestamp with time zone NOT NULL,
	"warned_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "ganztag_external_leaders" ADD CONSTRAINT "ganztag_external_leaders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_external_leaders" ADD CONSTRAINT "ganztag_external_leaders_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_external_leaders" ADD CONSTRAINT "ganztag_external_leaders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;