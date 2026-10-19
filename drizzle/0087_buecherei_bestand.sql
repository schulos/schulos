CREATE TYPE "public"."buecherei_condition" AS ENUM('neu', 'gut', 'gebraucht', 'schlecht');--> statement-breakpoint
CREATE TYPE "public"."buecherei_media_type" AS ENUM('buch', 'film', 'spiel', 'geraet', 'sonstiges');--> statement-breakpoint
CREATE TABLE "buecherei_copies" (
	"id" text PRIMARY KEY NOT NULL,
	"title_id" text NOT NULL,
	"seq" integer NOT NULL,
	"barcode" text NOT NULL,
	"signature" text,
	"location" text,
	"condition" "buecherei_condition" DEFAULT 'gut' NOT NULL,
	"withdrawn_on" date,
	"withdrawn_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buecherei_copies_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE "buecherei_titles" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"isbn" text,
	"publisher" text,
	"year" integer,
	"keywords" text,
	"age_from" integer,
	"media_type" "buecherei_media_type" DEFAULT 'buch' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buecherei_copies" ADD CONSTRAINT "buecherei_copies_title_id_buecherei_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."buecherei_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buecherei_copies_title_idx" ON "buecherei_copies" USING btree ("title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_copies_seq_idx" ON "buecherei_copies" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_titles_isbn_idx" ON "buecherei_titles" USING btree ("isbn") WHERE "buecherei_titles"."isbn" is not null;