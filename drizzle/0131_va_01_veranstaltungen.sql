CREATE TYPE "public"."gebaeude_event_history_kind" AS ENUM('angemeldet', 'freigegeben', 'bestaetigt', 'rueckfrage', 'antwort', 'abgelehnt', 'abgesagt');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_event_seating" AS ENUM('keine', 'reihen', 'tische', 'tafel', 'absprache');--> statement-breakpoint
CREATE TYPE "public"."gebaeude_event_status" AS ENUM('freigabe', 'angemeldet', 'rueckfrage', 'bestaetigt', 'abgelehnt', 'abgesagt');--> statement-breakpoint
CREATE TABLE "gebaeude_veranstaltung_sperren" (
	"event_id" text NOT NULL,
	"room_block_id" text NOT NULL,
	CONSTRAINT "gebaeude_veranstaltung_sperren_event_id_room_block_id_pk" PRIMARY KEY("event_id","room_block_id")
);
--> statement-breakpoint
CREATE TABLE "gebaeude_veranstaltung_verlauf" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"kind" "gebaeude_event_history_kind" NOT NULL,
	"text" text
);
--> statement-breakpoint
CREATE TABLE "gebaeude_veranstaltung_raeume" (
	"event_id" text NOT NULL,
	"room_id" text NOT NULL,
	CONSTRAINT "gebaeude_veranstaltung_raeume_event_id_room_id_pk" PRIMARY KEY("event_id","room_id")
);
--> statement-breakpoint
CREATE TABLE "gebaeude_veranstaltungen" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"organizer_id" text,
	"status" "gebaeude_event_status" DEFAULT 'angemeldet' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"setup_at" timestamp with time zone NOT NULL,
	"teardown_at" timestamp with time zone NOT NULL,
	"location" text,
	"persons" integer NOT NULL,
	"seating" "gebaeude_event_seating" DEFAULT 'keine' NOT NULL,
	"needs_tech" boolean DEFAULT false NOT NULL,
	"needs_locking" boolean DEFAULT false NOT NULL,
	"needs_heating" boolean DEFAULT false NOT NULL,
	"needs_cleaning" boolean DEFAULT false NOT NULL,
	"details" text,
	"calendar_event_id" text,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltung_sperren" ADD CONSTRAINT "gebaeude_veranstaltung_sperren_event_id_gebaeude_veranstaltungen_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."gebaeude_veranstaltungen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltung_sperren" ADD CONSTRAINT "gebaeude_veranstaltung_sperren_room_block_id_timetable_room_blocks_id_fk" FOREIGN KEY ("room_block_id") REFERENCES "public"."timetable_room_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltung_verlauf" ADD CONSTRAINT "gebaeude_veranstaltung_verlauf_event_id_gebaeude_veranstaltungen_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."gebaeude_veranstaltungen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltung_verlauf" ADD CONSTRAINT "gebaeude_veranstaltung_verlauf_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltung_raeume" ADD CONSTRAINT "gebaeude_veranstaltung_raeume_event_id_gebaeude_veranstaltungen_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."gebaeude_veranstaltungen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltung_raeume" ADD CONSTRAINT "gebaeude_veranstaltung_raeume_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltungen" ADD CONSTRAINT "gebaeude_veranstaltungen_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gebaeude_veranstaltungen" ADD CONSTRAINT "gebaeude_veranstaltungen_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gebaeude_veranstaltung_verlauf_event_idx" ON "gebaeude_veranstaltung_verlauf" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "gebaeude_veranstaltung_raeume_room_idx" ON "gebaeude_veranstaltung_raeume" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "gebaeude_veranstaltungen_time_idx" ON "gebaeude_veranstaltungen" USING btree ("teardown_at","setup_at");--> statement-breakpoint
CREATE INDEX "gebaeude_veranstaltungen_organizer_idx" ON "gebaeude_veranstaltungen" USING btree ("organizer_id");--> statement-breakpoint
-- VA-01: Recht `gebaeude.event_approve` („Veranstaltungen freigeben“, nur wirksam mit eingeschalteter Schulleitungs-Freigabe) für die
-- Gruppe Schulleitung – wie 0112 nur, wenn es die Gruppe mit dieser festen ID und diesem Slug gibt. Keine Rollen-Vorgabe. Idempotent.
INSERT INTO "grants" ("id", "permission", "group_id")
SELECT gen_random_uuid()::text, 'gebaeude.event_approve', 'g-schulleitung'
WHERE EXISTS (SELECT 1 FROM "groups" WHERE "id" = 'g-schulleitung' AND "slug" = 'schulleitung')
ON CONFLICT DO NOTHING;
