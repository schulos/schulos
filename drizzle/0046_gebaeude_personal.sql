CREATE TYPE "public"."gebaeude_category" AS ENUM('gebaeude', 'technik', 'it', 'reinigung', 'sicherheit', 'sonstiges');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_event_kind" AS ENUM('status', 'kommentar', 'zuweisung', 'raumsperre', 'foto');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_priority" AS ENUM('niedrig', 'normal', 'hoch', 'gefahr');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_status" AS ENUM('neu', 'angenommen', 'in_arbeit', 'wartet_extern', 'erledigt', 'abgelehnt');--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'personal' BEFORE 'verwaltung';--> statement-breakpoint
CREATE TABLE "gebaeude_responsibilities" (
	"category" "gebaeude_category" PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gebaeude_ticket_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"kind" "gebaeude_event_kind" NOT NULL,
	"status_from" "gebaeude_status",
	"status_to" "gebaeude_status",
	"text" text
);
--> statement-breakpoint
CREATE TABLE "gebaeude_ticket_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gebaeude_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"category" "gebaeude_category" NOT NULL,
	"priority" "gebaeude_priority" DEFAULT 'normal' NOT NULL,
	"status" "gebaeude_status" DEFAULT 'neu' NOT NULL,
	"room_id" text,
	"location" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"reporter_id" text,
	"assignee_id" text,
	"room_block_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gebaeude_responsibilities" ADD CONSTRAINT "gebaeude_responsibilities_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_ticket_events" ADD CONSTRAINT "gebaeude_ticket_events_ticket_id_gebaeude_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."gebaeude_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_ticket_events" ADD CONSTRAINT "gebaeude_ticket_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_ticket_photos" ADD CONSTRAINT "gebaeude_ticket_photos_ticket_id_gebaeude_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."gebaeude_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_ticket_photos" ADD CONSTRAINT "gebaeude_ticket_photos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_tickets" ADD CONSTRAINT "gebaeude_tickets_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gebaeude_tickets" ADD CONSTRAINT "gebaeude_tickets_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_tickets" ADD CONSTRAINT "gebaeude_tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_tickets" ADD CONSTRAINT "gebaeude_tickets_room_block_id_timetable_room_blocks_id_fk" FOREIGN KEY ("room_block_id") REFERENCES "public"."timetable_room_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gebaeude_ticket_events_ticket_idx" ON "gebaeude_ticket_events" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "gebaeude_ticket_photos_ticket_idx" ON "gebaeude_ticket_photos" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gebaeude_tickets_number_uq" ON "gebaeude_tickets" USING btree ("year","seq");--> statement-breakpoint
CREATE INDEX "gebaeude_tickets_status_idx" ON "gebaeude_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "gebaeude_tickets_reporter_idx" ON "gebaeude_tickets" USING btree ("reporter_id");