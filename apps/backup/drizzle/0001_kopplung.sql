CREATE TABLE "instances" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"rest_user" text NOT NULL,
	"repo_password_enc" text NOT NULL,
	"agent_token_hash" text NOT NULL,
	"main_url" text,
	"paired_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "instances_rest_user_unique" UNIQUE("rest_user"),
	CONSTRAINT "instances_agent_token_hash_unique" UNIQUE("agent_token_hash")
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"lookup" text NOT NULL,
	"key_enc" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"instance_id" text,
	CONSTRAINT "pairing_codes_lookup_unique" UNIQUE("lookup")
);
--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_paired_by_users_id_fk" FOREIGN KEY ("paired_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;