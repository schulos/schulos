CREATE TABLE "building_floors" (
	"id" text PRIMARY KEY NOT NULL,
	"building_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buildings" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "label_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"room_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_codes_kind" CHECK ("label_codes"."kind" in ('raum')),
	CONSTRAINT "label_codes_target" CHECK (("label_codes"."kind" = 'raum') = ("label_codes"."room_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "building_id" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "floor_id" text;--> statement-breakpoint
ALTER TABLE "building_floors" ADD CONSTRAINT "building_floors_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_codes" ADD CONSTRAINT "label_codes_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "building_floors_name_uq" ON "building_floors" USING btree ("building_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "buildings_name_uq" ON "buildings" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "label_codes_room_uq" ON "label_codes" USING btree ("room_id");--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_floor_id_building_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."building_floors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- RS-10: Datenübernahme Freitext → Stammdaten. Je Gebäude die häufigste Schreibweise (bei Gleichstand die erste), Leerraum
-- außen weg; Groß-/Kleinschreibung zählt nicht. Reihenfolge alphabetisch (Byte-Ordnung, unabhängig von der Collation).
INSERT INTO "buildings" ("id", "name", "sort_order")
SELECT gen_random_uuid()::text, s.name, (row_number() OVER (ORDER BY lower(s.name) COLLATE "C", s.name COLLATE "C") * 10)::int
FROM (
  SELECT DISTINCT ON (lower(c.name)) c.name
  FROM (SELECT btrim("building") AS name, count(*) AS n FROM "rooms" WHERE btrim(coalesce("building", '')) <> '' GROUP BY btrim("building")) c
  ORDER BY lower(c.name), c.n DESC, c.name COLLATE "C"
) s;--> statement-breakpoint
-- Räume mit Etage, aber ohne Gebäude: Etagen hängen immer an einem Gebäude → Sammelgebäude „Ohne Gebäude“ (wie die
-- Überschrift der Raumliste bisher), ans Ende sortiert
INSERT INTO "buildings" ("id", "name", "sort_order")
SELECT gen_random_uuid()::text, 'Ohne Gebäude', 100000
WHERE EXISTS (SELECT 1 FROM "rooms" WHERE btrim(coalesce("building", '')) = '' AND btrim(coalesce("floor", '')) <> '')
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "rooms" r SET "building_id" = b."id"
FROM "buildings" b
WHERE lower(b."name") = lower(CASE WHEN btrim(coalesce(r."building", '')) = '' THEN 'Ohne Gebäude' ELSE btrim(r."building") END)
  AND (btrim(coalesce(r."building", '')) <> '' OR btrim(coalesce(r."floor", '')) <> '');--> statement-breakpoint
-- Etagen je Gebäude: Untergeschoss, Erdgeschoss, „1. OG“, „2. OG“ … nach der Zahl, Dachgeschoss, dann der Rest alphabetisch
INSERT INTO "building_floors" ("id", "building_id", "name", "sort_order")
SELECT gen_random_uuid()::text, s.building_id, s.name,
  (row_number() OVER (PARTITION BY s.building_id ORDER BY s.rank, lower(s.name) COLLATE "C", s.name COLLATE "C") * 10)::int
FROM (
  SELECT DISTINCT ON (c.building_id, lower(c.name)) c.building_id, c.name,
    CASE
      WHEN c.name ~* '^(kg|ug|keller|untergeschoss|souterrain)' THEN -10
      WHEN c.name ~* '^(eg|erdgeschoss|parterre|hochparterre)' THEN 0
      WHEN c.name ~ '^[0-9]' THEN substring(c.name from '^([0-9]{1,3})')::int * 10
      WHEN c.name ~* '^(dg|dach)' THEN 90000
      ELSE 99000
    END AS rank
  FROM (
    SELECT "building_id" AS building_id, btrim("floor") AS name, count(*) AS n FROM "rooms"
    WHERE "building_id" IS NOT NULL AND btrim(coalesce("floor", '')) <> '' GROUP BY "building_id", btrim("floor")
  ) c
  ORDER BY c.building_id, lower(c.name), c.n DESC, c.name COLLATE "C"
) s;--> statement-breakpoint
UPDATE "rooms" r SET "floor_id" = f."id"
FROM "building_floors" f
WHERE f."building_id" = r."building_id" AND btrim(coalesce(r."floor", '')) <> '' AND lower(f."name") = lower(btrim(r."floor"));--> statement-breakpoint
-- Anzeigekopien aus den Stammdaten (einheitliche Schreibweise; leere Angaben werden NULL)
UPDATE "rooms" r SET "building" = b."name" FROM "buildings" b WHERE b."id" = r."building_id";--> statement-breakpoint
UPDATE "rooms" r SET "floor" = f."name" FROM "building_floors" f WHERE f."id" = r."floor_id";--> statement-breakpoint
UPDATE "rooms" SET "building" = NULL WHERE "building_id" IS NULL AND "building" IS NOT NULL;--> statement-breakpoint
UPDATE "rooms" SET "floor" = NULL WHERE "floor_id" IS NULL AND "floor" IS NOT NULL;
