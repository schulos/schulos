CREATE TYPE "public"."gebaeude_asset_condition" AS ENUM('neu', 'gut', 'gebraucht', 'defekt');--> statement-breakpoint
CREATE TABLE "gebaeude_asset_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"inspection_required" boolean DEFAULT false NOT NULL,
	"responsible_group_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gebaeude_inventory_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "label_codes" DROP CONSTRAINT "label_codes_kind";--> statement-breakpoint
ALTER TABLE "label_codes" DROP CONSTRAINT "label_codes_target";--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "label_codes" ADD COLUMN "asset_id" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "building_id" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "floor_id" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "condition" "gebaeude_asset_condition";--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "price_cents" integer;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "supplier" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "financing" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "bound_until" date;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "warranty_until" date;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "retired_on" date;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "retired_reason" text;--> statement-breakpoint
ALTER TABLE "gebaeude_inspection_types" ADD COLUMN "category_id" text;--> statement-breakpoint
-- INV-01 Stufe 1: Datenübernahme Enum → Kategorie. Jeder bisherige Enum-Wert wird eine Kategorie mit demselben Schlüssel
-- (Namen/Präfixe wie die Vorlage in src/modules/gebaeude/kategorien.ts; die übrigen Vorlagen legt die App beim ersten Aufruf an).
INSERT INTO "gebaeude_asset_categories" ("id", "key", "name", "prefix", "inspection_required", "sort_order") VALUES
  (gen_random_uuid()::text, 'elektro_ortsveraenderlich', 'Elektrogerät (ortsveränderlich)', 'EL', true, 10),
  (gen_random_uuid()::text, 'feuerloescher', 'Feuerlöscher', 'FL', true, 20),
  (gen_random_uuid()::text, 'spielgeraet', 'Spielgerät (außen)', 'SP', true, 30),
  (gen_random_uuid()::text, 'sportgeraet', 'Sport (Großgeräte, Zeitmessanlage)', 'SG', true, 40),
  (gen_random_uuid()::text, 'aufzug', 'Aufzug', 'AZ', true, 50),
  (gen_random_uuid()::text, 'tor_tuer', 'Kraftbetätigtes Tor/Tür', 'TT', true, 60),
  (gen_random_uuid()::text, 'leiter', 'Leiter/Tritt', 'LE', true, 70),
  (gen_random_uuid()::text, 'erste_hilfe', 'Erste-Hilfe-Material', 'EH', true, 80),
  (gen_random_uuid()::text, 'lueftung', 'Lüftung', 'LU', false, 90),
  (gen_random_uuid()::text, 'sonstiges', 'Sonstiges', 'SO', false, 900);--> statement-breakpoint
UPDATE "gebaeude_assets" a SET "category_id" = c."id" FROM "gebaeude_asset_categories" c WHERE c."key" = a."kind"::text;--> statement-breakpoint
UPDATE "gebaeude_assets" a SET "category_id" = c."id" FROM "gebaeude_asset_categories" c WHERE a."category_id" IS NULL AND c."key" = 'sonstiges';--> statement-breakpoint
UPDATE "gebaeude_inspection_types" t SET "category_id" = c."id" FROM "gebaeude_asset_categories" c WHERE c."key" = t."asset_kind"::text;--> statement-breakpoint
-- Ausgemusterte Anlagen (bisher „außer Betrieb“) bekommen ein Datum, damit sie als Nachweis erkennbar bleiben (inv-8)
UPDATE "gebaeude_assets" SET "retired_on" = current_date WHERE "active" = false AND "retired_on" IS NULL;--> statement-breakpoint
-- Freitext-Gebäude → Stammdaten (wie RS-10 bei den Räumen): fehlende Gebäude anlegen, dann zuordnen
INSERT INTO "buildings" ("id", "name", "sort_order")
SELECT gen_random_uuid()::text, s.name, 50000 + (row_number() OVER (ORDER BY lower(s.name) COLLATE "C") * 10)::int
FROM (
  SELECT DISTINCT ON (lower(btrim(a."building"))) btrim(a."building") AS name
  FROM "gebaeude_assets" a
  WHERE btrim(coalesce(a."building", '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM "buildings" b WHERE lower(b."name") = lower(btrim(a."building")))
  ORDER BY lower(btrim(a."building")), btrim(a."building") COLLATE "C"
) s;--> statement-breakpoint
UPDATE "gebaeude_assets" a SET "building_id" = b."id" FROM "buildings" b WHERE btrim(coalesce(a."building", '')) <> '' AND lower(b."name") = lower(btrim(a."building"));--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ALTER COLUMN "category_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "gebaeude_asset_categories" ADD CONSTRAINT "gebaeude_asset_categories_responsible_group_id_groups_id_fk" FOREIGN KEY ("responsible_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gebaeude_asset_categories_key_uq" ON "gebaeude_asset_categories" USING btree ("key");--> statement-breakpoint
ALTER TABLE "label_codes" ADD CONSTRAINT "label_codes_asset_id_gebaeude_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gebaeude_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD CONSTRAINT "gebaeude_assets_category_id_gebaeude_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."gebaeude_asset_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD CONSTRAINT "gebaeude_assets_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD CONSTRAINT "gebaeude_assets_floor_id_building_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."building_floors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_inspection_types" ADD CONSTRAINT "gebaeude_inspection_types_category_id_gebaeude_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."gebaeude_asset_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "label_codes_asset_uq" ON "label_codes" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "gebaeude_assets_category_idx" ON "gebaeude_assets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "gebaeude_assets_room_idx" ON "gebaeude_assets" USING btree ("room_id");--> statement-breakpoint
ALTER TABLE "label_codes" ADD CONSTRAINT "label_codes_kind" CHECK ("label_codes"."kind" in ('raum', 'inventar'));--> statement-breakpoint
ALTER TABLE "label_codes" ADD CONSTRAINT "label_codes_target" CHECK ((("label_codes"."kind" = 'raum') = ("label_codes"."room_id" is not null)) and (("label_codes"."kind" = 'inventar') = ("label_codes"."asset_id" is not null)));
