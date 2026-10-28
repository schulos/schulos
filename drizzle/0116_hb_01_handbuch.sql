CREATE TYPE "public"."hilfe_page_status" AS ENUM('entwurf', 'veroeffentlicht');--> statement-breakpoint
CREATE TABLE "hilfe_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"section_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" "hilfe_page_status" DEFAULT 'entwurf' NOT NULL,
	"contact_id" text,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_on" date NOT NULL,
	"review_reminded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hilfe_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hilfe_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"role" "role",
	"group_id" text,
	CONSTRAINT "hilfe_targets_one" CHECK (("hilfe_targets"."role" is null) <> ("hilfe_targets"."group_id" is null))
);
--> statement-breakpoint
ALTER TABLE "hilfe_pages" ADD CONSTRAINT "hilfe_pages_section_id_hilfe_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."hilfe_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_pages" ADD CONSTRAINT "hilfe_pages_contact_id_users_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_pages" ADD CONSTRAINT "hilfe_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_pages" ADD CONSTRAINT "hilfe_pages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_targets" ADD CONSTRAINT "hilfe_targets_page_id_hilfe_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."hilfe_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_targets" ADD CONSTRAINT "hilfe_targets_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hilfe_pages_slug_uq" ON "hilfe_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "hilfe_pages_section_idx" ON "hilfe_pages" USING btree ("section_id","position");--> statement-breakpoint
CREATE INDEX "hilfe_pages_contact_idx" ON "hilfe_pages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "hilfe_pages_fts_idx" ON "hilfe_pages" USING gin (to_tsvector('german', "title" || ' ' || "body"));--> statement-breakpoint
CREATE UNIQUE INDEX "hilfe_targets_role_uq" ON "hilfe_targets" USING btree ("page_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "hilfe_targets_group_uq" ON "hilfe_targets" USING btree ("page_id","group_id");