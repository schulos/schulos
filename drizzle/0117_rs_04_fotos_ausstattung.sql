CREATE TABLE "room_equipment_items" (
	"room_id" text NOT NULL,
	"type_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_equipment_items_room_id_type_id_pk" PRIMARY KEY("room_id","type_id"),
	CONSTRAINT "room_equipment_items_quantity" CHECK ("room_equipment_items"."quantity" between 1 and 9999)
);
--> statement-breakpoint
CREATE TABLE "room_equipment_types" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumb_key" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"caption" text,
	"is_cover" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_equipment_items" ADD CONSTRAINT "room_equipment_items_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_equipment_items" ADD CONSTRAINT "room_equipment_items_type_id_room_equipment_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."room_equipment_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_photos" ADD CONSTRAINT "room_photos_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_equipment_items_type_idx" ON "room_equipment_items" USING btree ("type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_equipment_types_name_uq" ON "room_equipment_types" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "room_photos_room_idx" ON "room_photos" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_photos_cover_uq" ON "room_photos" USING btree ("room_id") WHERE "room_photos"."is_cover";--> statement-breakpoint
-- RS-05: die acht festen Einträge werden Katalogeinträge (Schlüssel bleibt die ID), Ausstattung aller Räume mit Menge 1 übernehmen
INSERT INTO "room_equipment_types" ("id", "name") VALUES
	('beamer', 'Beamer'),
	('tafel_digital', 'Digitale Tafel'),
	('dokukamera', 'Dokumentenkamera'),
	('lehrer_pc', 'Lehrer-PC'),
	('schueler_pcs', 'Schüler-PCs'),
	('audio', 'Audioanlage'),
	('waschbecken', 'Waschbecken'),
	('abzug', 'Abzug');--> statement-breakpoint
-- unbekannte Schlüssel (nur bei Datenbestand an der Prüfung vorbei) gehen nicht verloren: Schlüssel wird Name
INSERT INTO "room_equipment_types" ("id", "name")
	SELECT DISTINCT e, e FROM "rooms", unnest("rooms"."equipment") AS e
	ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "room_equipment_items" ("room_id", "type_id", "quantity")
	SELECT DISTINCT r."id", e, 1 FROM "rooms" r, unnest(r."equipment") AS e
	WHERE e IN (SELECT "id" FROM "room_equipment_types");--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "equipment";