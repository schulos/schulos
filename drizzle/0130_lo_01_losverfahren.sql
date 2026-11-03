CREATE TYPE "public"."anmeldung_los_status" AS ENUM('vorbereitet', 'gezogen', 'uebernommen', 'verworfen');--> statement-breakpoint
CREATE TABLE "anmeldung_lose" (
	"id" text PRIMARY KEY NOT NULL,
	"verfahren_id" text NOT NULL,
	"seq" integer NOT NULL,
	"status" "anmeldung_los_status" DEFAULT 'vorbereitet' NOT NULL,
	"places" integer NOT NULL,
	"participants" jsonb NOT NULL,
	"seed" text NOT NULL,
	"seed_hash" text NOT NULL,
	"draw_order" jsonb,
	"witnesses" text,
	"reason" text,
	"replaces_id" text,
	"prepared_by" text,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drawn_by" text,
	"drawn_at" timestamp with time zone,
	"applied_by" text,
	"applied_at" timestamp with time zone,
	"discarded_by" text,
	"discarded_at" timestamp with time zone,
	CONSTRAINT "anmeldung_lose_places" CHECK ("anmeldung_lose"."places" >= 1)
);
--> statement-breakpoint
ALTER TABLE "anmeldung_antraege" ADD COLUMN "waitlist_rank" integer;--> statement-breakpoint
ALTER TABLE "anmeldung_lose" ADD CONSTRAINT "anmeldung_lose_verfahren_id_anmeldung_verfahren_id_fk" FOREIGN KEY ("verfahren_id") REFERENCES "public"."anmeldung_verfahren"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_lose" ADD CONSTRAINT "anmeldung_lose_replaces_id_anmeldung_lose_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."anmeldung_lose"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_lose" ADD CONSTRAINT "anmeldung_lose_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_lose" ADD CONSTRAINT "anmeldung_lose_drawn_by_users_id_fk" FOREIGN KEY ("drawn_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_lose" ADD CONSTRAINT "anmeldung_lose_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_lose" ADD CONSTRAINT "anmeldung_lose_discarded_by_users_id_fk" FOREIGN KEY ("discarded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anmeldung_lose_seq_uq" ON "anmeldung_lose" USING btree ("verfahren_id","seq");