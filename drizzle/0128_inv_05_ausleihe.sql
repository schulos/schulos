ALTER TYPE "public"."gebaeude_inventory_item_state" ADD VALUE 'verliehen';--> statement-breakpoint
CREATE TABLE "gebaeude_loans" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"user_id" text,
	"loaned_on" date NOT NULL,
	"due_on" date NOT NULL,
	"accessories" text,
	"returned_at" timestamp with time zone,
	"return_note" text,
	"reminded_due_on" date,
	"overdue_level" integer DEFAULT 0 NOT NULL,
	"overdue_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gebaeude_loans" ADD CONSTRAINT "gebaeude_loans_asset_id_gebaeude_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gebaeude_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_loans" ADD CONSTRAINT "gebaeude_loans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gebaeude_loans_open_asset_uq" ON "gebaeude_loans" USING btree ("asset_id") WHERE returned_at is null;--> statement-breakpoint
CREATE INDEX "gebaeude_loans_user_idx" ON "gebaeude_loans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gebaeude_loans_asset_idx" ON "gebaeude_loans" USING btree ("asset_id");