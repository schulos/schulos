CREATE TYPE "public"."anmeldung_klassenwunsch_art" AS ENUM('zusammen', 'nicht_zusammen');--> statement-breakpoint
CREATE TABLE "anmeldung_klassenwuensche" (
	"id" text PRIMARY KEY NOT NULL,
	"antrag_id" text NOT NULL,
	"partner_antrag_id" text NOT NULL,
	"art" "anmeldung_klassenwunsch_art" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anmeldung_klassenwuensche_selbst" CHECK ("anmeldung_klassenwuensche"."antrag_id" <> "anmeldung_klassenwuensche"."partner_antrag_id")
);
--> statement-breakpoint
ALTER TABLE "anmeldung_antraege" ADD COLUMN "family_separate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "anmeldung_klassenwuensche" ADD CONSTRAINT "anmeldung_klassenwuensche_antrag_id_anmeldung_antraege_id_fk" FOREIGN KEY ("antrag_id") REFERENCES "public"."anmeldung_antraege"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_klassenwuensche" ADD CONSTRAINT "anmeldung_klassenwuensche_partner_antrag_id_anmeldung_antraege_id_fk" FOREIGN KEY ("partner_antrag_id") REFERENCES "public"."anmeldung_antraege"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anmeldung_klassenwuensche" ADD CONSTRAINT "anmeldung_klassenwuensche_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anmeldung_klassenwuensche_paar_uq" ON "anmeldung_klassenwuensche" USING btree ("antrag_id","partner_antrag_id");--> statement-breakpoint
CREATE INDEX "anmeldung_klassenwuensche_partner_idx" ON "anmeldung_klassenwuensche" USING btree ("partner_antrag_id");