CREATE TYPE "public"."texte_mode" AS ENUM('alle', 'leitung');--> statement-breakpoint
CREATE TABLE "texte_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"owner_id" text,
	"title" text NOT NULL,
	"mode" texte_mode DEFAULT 'alle' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "texte_docs" ADD CONSTRAINT "texte_docs_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "texte_docs" ADD CONSTRAINT "texte_docs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "texte_docs_group_idx" ON "texte_docs" USING btree ("group_id");