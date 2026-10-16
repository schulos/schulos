CREATE TABLE "privacy_deletion_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"triggered_by" text,
	"result" jsonb NOT NULL,
	"total" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"group_id" text,
	"reason" text NOT NULL,
	"until" date NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_holds_target" CHECK (("privacy_holds"."user_id" is null) <> ("privacy_holds"."group_id" is null))
);
--> statement-breakpoint
ALTER TABLE "privacy_deletion_runs" ADD CONSTRAINT "privacy_deletion_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_holds" ADD CONSTRAINT "privacy_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_holds" ADD CONSTRAINT "privacy_holds_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_holds" ADD CONSTRAINT "privacy_holds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;