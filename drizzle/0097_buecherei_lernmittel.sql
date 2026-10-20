CREATE TYPE "public"."buecherei_material_provision" AS ENUM('leihe', 'kauf');--> statement-breakpoint
CREATE TABLE "buecherei_booklists" (
	"grade_level" integer PRIMARY KEY NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buecherei_material_copies" (
	"id" text PRIMARY KEY NOT NULL,
	"material_id" text NOT NULL,
	"seq" integer NOT NULL,
	"inventory_number" text NOT NULL,
	"condition" "buecherei_condition" DEFAULT 'neu' NOT NULL,
	"condition_note" text,
	"acquired_year" integer,
	"withdrawn_on" date,
	"withdrawn_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buecherei_material_copies_inventory_number_unique" UNIQUE("inventory_number")
);
--> statement-breakpoint
CREATE TABLE "buecherei_teaching_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"isbn" text,
	"publisher" text,
	"subject_id" text,
	"grades" integer[] NOT NULL,
	"course" text,
	"provision" "buecherei_material_provision" DEFAULT 'leihe' NOT NULL,
	"price_cents" integer,
	"note" text,
	"archived_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buecherei_teaching_materials_price" CHECK ("buecherei_teaching_materials"."price_cents" is null or "buecherei_teaching_materials"."price_cents" between 0 and 99999)
);
--> statement-breakpoint
ALTER TABLE "buecherei_booklists" ADD CONSTRAINT "buecherei_booklists_grade_level_grade_levels_level_fk" FOREIGN KEY ("grade_level") REFERENCES "public"."grade_levels"("level") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_material_copies" ADD CONSTRAINT "buecherei_material_copies_material_id_buecherei_teaching_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."buecherei_teaching_materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buecherei_teaching_materials" ADD CONSTRAINT "buecherei_teaching_materials_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "buecherei_material_copies_material_idx" ON "buecherei_material_copies" USING btree ("material_id");--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_material_copies_seq_idx" ON "buecherei_material_copies" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "buecherei_teaching_materials_isbn_idx" ON "buecherei_teaching_materials" USING btree ("isbn") WHERE "buecherei_teaching_materials"."isbn" is not null;