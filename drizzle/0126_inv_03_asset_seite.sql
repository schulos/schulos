CREATE TABLE "gebaeude_asset_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumb_key" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gebaeude_tickets" ADD COLUMN "asset_id" text;--> statement-breakpoint
ALTER TABLE "gebaeude_asset_photos" ADD CONSTRAINT "gebaeude_asset_photos_asset_id_gebaeude_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gebaeude_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gebaeude_asset_photos_asset_idx" ON "gebaeude_asset_photos" USING btree ("asset_id");--> statement-breakpoint
ALTER TABLE "gebaeude_tickets" ADD CONSTRAINT "gebaeude_tickets_asset_id_gebaeude_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gebaeude_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gebaeude_tickets_asset_idx" ON "gebaeude_tickets" USING btree ("asset_id");