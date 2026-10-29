CREATE TABLE "room_layouts" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"name" text NOT NULL,
	"variant" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"rows" integer NOT NULL,
	"cols" integer NOT NULL,
	"cells" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_layouts_rows" CHECK ("room_layouts"."rows" between 1 and 12),
	CONSTRAINT "room_layouts_cols" CHECK ("room_layouts"."cols" between 1 and 12),
	CONSTRAINT "room_layouts_variant" CHECK ("room_layouts"."variant" in ('reihen', 'u-form', 'gruppen', 'pruefung', 'frei'))
);
--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD COLUMN "layout_id" text;--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD COLUMN "layout_copied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_layouts" ADD CONSTRAINT "room_layouts_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "room_layouts_name_uq" ON "room_layouts" USING btree ("room_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "room_layouts_default_uq" ON "room_layouts" USING btree ("room_id") WHERE "room_layouts"."is_default";--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD CONSTRAINT "sitzplan_plans_layout_id_room_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."room_layouts"("id") ON DELETE set null ON UPDATE no action;