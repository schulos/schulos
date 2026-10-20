CREATE TABLE "buecherei_material_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"copy_id" text NOT NULL,
	"user_id" text,
	"school_year_id" text NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"returned_on" date,
	"finding" text,
	"finding_resolved_on" date,
	"dunning_level" integer DEFAULT 0 NOT NULL,
	"dunned_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buecherei_material_issues" ADD CONSTRAINT "buecherei_material_issues_copy_id_buecherei_material_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."buecherei_material_copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_material_issues" ADD CONSTRAINT "buecherei_material_issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_material_issues" ADD CONSTRAINT "buecherei_material_issues_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_material_issues_open_copy_idx" ON "buecherei_material_issues" USING btree ("copy_id") WHERE "buecherei_material_issues"."returned_on" is null;--> statement-breakpoint
CREATE INDEX "buecherei_material_issues_user_idx" ON "buecherei_material_issues" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "buecherei_material_issues_year_idx" ON "buecherei_material_issues" USING btree ("school_year_id");