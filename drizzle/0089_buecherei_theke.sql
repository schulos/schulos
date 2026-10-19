CREATE TABLE "buecherei_loans" (
	"id" text PRIMARY KEY NOT NULL,
	"copy_id" text NOT NULL,
	"user_id" text,
	"loaned_on" date NOT NULL,
	"due_on" date NOT NULL,
	"renewals" integer DEFAULT 0 NOT NULL,
	"returned_on" date,
	"finding" text,
	"finding_resolved_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buecherei_stats" (
	"month" text NOT NULL,
	"media_type" "buecherei_media_type" NOT NULL,
	"loans" integer DEFAULT 0 NOT NULL,
	"renewals" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "buecherei_stats_month_media_type_pk" PRIMARY KEY("month","media_type")
);
--> statement-breakpoint
ALTER TABLE "buecherei_loans" ADD CONSTRAINT "buecherei_loans_copy_id_buecherei_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."buecherei_copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_loans" ADD CONSTRAINT "buecherei_loans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_loans_open_copy_idx" ON "buecherei_loans" USING btree ("copy_id") WHERE "buecherei_loans"."returned_on" is null;--> statement-breakpoint
CREATE INDEX "buecherei_loans_user_idx" ON "buecherei_loans" USING btree ("user_id");