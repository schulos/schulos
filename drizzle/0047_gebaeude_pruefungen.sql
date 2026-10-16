CREATE TYPE "public"."gebaeude_asset_kind" AS ENUM('elektro_ortsveraenderlich', 'feuerloescher', 'spielgeraet', 'sportgeraet', 'aufzug', 'tor_tuer', 'leiter', 'erste_hilfe', 'lueftung', 'sonstiges');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_inspection_result" AS ENUM('ok', 'mangel', 'ausser_betrieb');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_inspection_target" AS ENUM('anlage', 'raum', 'gebaeude');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_responsible" AS ENUM('schule', 'schultraeger', 'extern');--> statement-breakpoint
CREATE TABLE "gebaeude_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "gebaeude_asset_kind" NOT NULL,
	"room_id" text,
	"building" text,
	"inventory_no" text,
	"manufacturer" text,
	"serial" text,
	"acquired_on" date,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gebaeude_assets_inventory_no_unique" UNIQUE("inventory_no")
);
--> statement-breakpoint
CREATE TABLE "gebaeude_inspection_types" (
	"id" text PRIMARY KEY NOT NULL,
	"template_key" text,
	"name" text NOT NULL,
	"applies_to" "gebaeude_inspection_target" NOT NULL,
	"asset_kind" "gebaeude_asset_kind",
	"interval_months" integer NOT NULL,
	"warn_days" integer DEFAULT 30 NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"responsible" "gebaeude_responsible" DEFAULT 'schultraeger' NOT NULL,
	"note" text,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gebaeude_inspection_types_template_key_unique" UNIQUE("template_key")
);
--> statement-breakpoint
CREATE TABLE "gebaeude_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"type_id" text NOT NULL,
	"asset_id" text,
	"room_id" text,
	"building" text,
	"due_on" date NOT NULL,
	"done_on" date,
	"result" "gebaeude_inspection_result",
	"company" text,
	"report_key" text,
	"report_size" integer,
	"note" text,
	"ticket_id" text,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gebaeude_maintenance" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"provider" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"building" text,
	"note" text,
	"blocks_rooms" boolean DEFAULT false NOT NULL,
	"calendar_event_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gebaeude_maintenance_rooms" (
	"maintenance_id" text NOT NULL,
	"room_id" text NOT NULL,
	"room_block_id" text,
	CONSTRAINT "gebaeude_maintenance_rooms_maintenance_id_room_id_pk" PRIMARY KEY("maintenance_id","room_id")
);
--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD CONSTRAINT "gebaeude_assets_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gebaeude_inspections" ADD CONSTRAINT "gebaeude_inspections_type_id_gebaeude_inspection_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."gebaeude_inspection_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_inspections" ADD CONSTRAINT "gebaeude_inspections_asset_id_gebaeude_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."gebaeude_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_inspections" ADD CONSTRAINT "gebaeude_inspections_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gebaeude_inspections" ADD CONSTRAINT "gebaeude_inspections_ticket_id_gebaeude_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."gebaeude_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_maintenance" ADD CONSTRAINT "gebaeude_maintenance_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_maintenance" ADD CONSTRAINT "gebaeude_maintenance_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_maintenance_rooms" ADD CONSTRAINT "gebaeude_maintenance_rooms_maintenance_id_gebaeude_maintenance_id_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."gebaeude_maintenance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_maintenance_rooms" ADD CONSTRAINT "gebaeude_maintenance_rooms_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gebaeude_maintenance_rooms" ADD CONSTRAINT "gebaeude_maintenance_rooms_room_block_id_timetable_room_blocks_id_fk" FOREIGN KEY ("room_block_id") REFERENCES "public"."timetable_room_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gebaeude_inspections_due_idx" ON "gebaeude_inspections" USING btree ("done_on","due_on");--> statement-breakpoint
CREATE INDEX "gebaeude_inspections_type_idx" ON "gebaeude_inspections" USING btree ("type_id");--> statement-breakpoint
CREATE INDEX "gebaeude_inspections_asset_idx" ON "gebaeude_inspections" USING btree ("asset_id");