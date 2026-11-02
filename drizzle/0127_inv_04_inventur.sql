CREATE TYPE "public"."gebaeude_inventory_item_state" AS ENUM('offen', 'gefunden', 'fehlt', 'falscher_raum', 'umgezogen');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_inventory_method" AS ENUM('etikett', 'scan', 'liste');--> statement-breakpoint
CREATE TABLE "gebaeude_inventories" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text,
	"room_label" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gebaeude_inventory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"inventory_id" text NOT NULL,
	"asset_id" text,
	"inventory_no" text,
	"name" text NOT NULL,
	"category_name" text NOT NULL,
	"expected" boolean NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"counted" integer,
	"home_room_id" text,
	"state" "gebaeude_inventory_item_state" DEFAULT 'offen' NOT NULL,
	"method" "gebaeude_inventory_method",
	"recorded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gebaeude_inventories" ADD CONSTRAINT "gebaeude_inventories_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gebaeude_inventory_items" ADD CONSTRAINT "gebaeude_inventory_items_inventory_id_gebaeude_inventories_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."gebaeude_inventories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_inventory_items" ADD CONSTRAINT "gebaeude_inventory_items_asset_id_gebaeude_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gebaeude_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gebaeude_inventories_room_idx" ON "gebaeude_inventories" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gebaeude_inventories_open_uq" ON "gebaeude_inventories" USING btree ("room_id") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "gebaeude_inventory_items_inventory_idx" ON "gebaeude_inventory_items" USING btree ("inventory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gebaeude_inventory_items_asset_uq" ON "gebaeude_inventory_items" USING btree ("inventory_id","asset_id");