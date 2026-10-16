CREATE TYPE "public"."anmeldung_antrag_status" AS ENUM('unbestaetigt', 'eingegangen', 'termin', 'vollstaendig', 'aufgenommen', 'warteliste', 'abgelehnt', 'zurueckgezogen', 'uebernommen');--> statement-breakpoint
CREATE TYPE "public"."anmeldung_ereignis_kind" AS ENUM('eingegangen', 'bestaetigt', 'termin', 'status', 'notiz', 'mail');--> statement-breakpoint
CREATE TYPE "public"."anmeldung_kind" AS ENUM('klasse5', 'oberstufe_ef', 'seiteneinstieg');--> statement-breakpoint
CREATE TYPE "public"."anmeldung_verfahren_status" AS ENUM('entwurf', 'offen', 'geschlossen', 'abgeschlossen');--> statement-breakpoint
CREATE TABLE "anmeldung_antraege" (
	"id" text PRIMARY KEY NOT NULL,
	"verfahren_id" text NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"status" "anmeldung_antrag_status" DEFAULT 'unbestaetigt' NOT NULL,
	"child_first_name" text NOT NULL,
	"child_last_name" text NOT NULL,
	"child_birth_date" date NOT NULL,
	"primary_school" text,
	"sibling" boolean DEFAULT false NOT NULL,
	"sibling_note" text,
	"second_choice_school" text,
	"parent1_name" text NOT NULL,
	"parent1_email" text NOT NULL,
	"parent1_phone" text,
	"address_street" text,
	"address_zip" text,
	"address_city" text,
	"parent2_name" text,
	"hints" text,
	"slot_id" text,
	"consent_at" timestamp with time zone NOT NULL,
	"confirm_token_hash" text,
	"confirm_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"access_token_hash" text,
	"access_expires_at" timestamp with time zone,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"transferred_user_id" text,
	"transferred_at" timestamp with time zone,
	"retention_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anmeldung_ereignisse" (
	"id" text PRIMARY KEY NOT NULL,
	"antrag_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"kind" "anmeldung_ereignis_kind" NOT NULL,
	"text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anmeldung_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"verfahren_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"room_id" text,
	"note" text,
	CONSTRAINT "anmeldung_slots_range" CHECK ("anmeldung_slots"."ends_at" > "anmeldung_slots"."starts_at"),
	CONSTRAINT "anmeldung_slots_capacity" CHECK ("anmeldung_slots"."capacity" between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "anmeldung_verfahren" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "anmeldung_kind" NOT NULL,
	"target_school_year_id" text NOT NULL,
	"target_grade_level" integer NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"capacity" integer,
	"intro" text DEFAULT '' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reject_keep_days" integer DEFAULT 60 NOT NULL,
	"status" "anmeldung_verfahren_status" DEFAULT 'entwurf' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anmeldung_verfahren_range" CHECK ("anmeldung_verfahren"."closes_at" > "anmeldung_verfahren"."opens_at"),
	CONSTRAINT "anmeldung_verfahren_keep" CHECK ("anmeldung_verfahren"."reject_keep_days" between 31 and 365)
);
--> statement-breakpoint
ALTER TABLE "anmeldung_antraege" ADD CONSTRAINT "anmeldung_antraege_verfahren_id_anmeldung_verfahren_id_fk" FOREIGN KEY ("verfahren_id") REFERENCES "public"."anmeldung_verfahren"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_antraege" ADD CONSTRAINT "anmeldung_antraege_slot_id_anmeldung_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."anmeldung_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_antraege" ADD CONSTRAINT "anmeldung_antraege_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_antraege" ADD CONSTRAINT "anmeldung_antraege_transferred_user_id_users_id_fk" FOREIGN KEY ("transferred_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_ereignisse" ADD CONSTRAINT "anmeldung_ereignisse_antrag_id_anmeldung_antraege_id_fk" FOREIGN KEY ("antrag_id") REFERENCES "public"."anmeldung_antraege"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_ereignisse" ADD CONSTRAINT "anmeldung_ereignisse_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_slots" ADD CONSTRAINT "anmeldung_slots_verfahren_id_anmeldung_verfahren_id_fk" FOREIGN KEY ("verfahren_id") REFERENCES "public"."anmeldung_verfahren"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_slots" ADD CONSTRAINT "anmeldung_slots_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "anmeldung_verfahren" ADD CONSTRAINT "anmeldung_verfahren_target_school_year_id_school_years_id_fk" FOREIGN KEY ("target_school_year_id") REFERENCES "public"."school_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_verfahren" ADD CONSTRAINT "anmeldung_verfahren_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anmeldung_antraege_number_uq" ON "anmeldung_antraege" USING btree ("year","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "anmeldung_antraege_confirm_uq" ON "anmeldung_antraege" USING btree ("confirm_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "anmeldung_antraege_access_uq" ON "anmeldung_antraege" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "anmeldung_antraege_verfahren_idx" ON "anmeldung_antraege" USING btree ("verfahren_id","status");--> statement-breakpoint
CREATE INDEX "anmeldung_antraege_slot_idx" ON "anmeldung_antraege" USING btree ("slot_id");--> statement-breakpoint
CREATE INDEX "anmeldung_antraege_email_idx" ON "anmeldung_antraege" USING btree ("parent1_email");--> statement-breakpoint
CREATE INDEX "anmeldung_ereignisse_antrag_idx" ON "anmeldung_ereignisse" USING btree ("antrag_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "anmeldung_slots_start_uq" ON "anmeldung_slots" USING btree ("verfahren_id","starts_at");