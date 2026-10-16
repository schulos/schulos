CREATE TABLE "two_factor_code_lists" (
	"user_id" text PRIMARY KEY NOT NULL,
	"codes" jsonb NOT NULL,
	"total" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "two_factor_code_lists" ADD CONSTRAINT "two_factor_code_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor_code_lists" ADD CONSTRAINT "two_factor_code_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;