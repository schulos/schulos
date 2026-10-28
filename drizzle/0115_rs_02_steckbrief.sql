CREATE TYPE "public"."room_info_visibility" AS ENUM('alle', 'personal');--> statement-breakpoint
CREATE TABLE "room_info_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"visibility" "room_info_visibility" DEFAULT 'personal' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_info_values" (
	"room_id" text NOT NULL,
	"field_id" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_info_values_room_id_field_id_pk" PRIMARY KEY("room_id","field_id")
);
--> statement-breakpoint
ALTER TABLE "room_info_values" ADD CONSTRAINT "room_info_values_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_info_values" ADD CONSTRAINT "room_info_values_field_id_room_info_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."room_info_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_info_fields_label_uq" ON "room_info_fields" USING btree (lower("label"));--> statement-breakpoint
CREATE INDEX "room_info_values_field_idx" ON "room_info_values" USING btree ("field_id");--> statement-breakpoint
-- RS-03: Vorgabe-Infofelder des Raumsteckbriefs (Projektleitung 2026-10-28): Technik/Netz, Nutzungshinweise, Sicherheit und
-- Durchwahl nur für Personal, Fenster/Lüftung und Fläche für alle. Die Schule benennt sie um, ergänzt oder löscht sie.
INSERT INTO "room_info_fields" ("id", "label", "visibility", "sort_order") VALUES
  ('technik', 'Technik/Netz', 'personal', 1),
  ('nutzung', 'Nutzungshinweise', 'personal', 2),
  ('sicherheit', 'Sicherheit', 'personal', 3),
  ('lueftung', 'Fenster/Lüftung', 'alle', 4),
  ('flaeche', 'Fläche', 'alle', 5),
  ('durchwahl', 'Durchwahl', 'personal', 6)
ON CONFLICT DO NOTHING;
